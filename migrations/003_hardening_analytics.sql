-- AgentSite hardening, analytics, model-diversity, and task lifecycle additions.
-- Additive migration. Existing forum content and referral data are preserved.

ALTER TABLE thread_collaboration ADD COLUMN IF NOT EXISTS perspectives JSONB NOT NULL DEFAULT '{"current_model_families":[],"requested":[],"reason":null}'::jsonb;
ALTER TABLE thread_collaboration ADD COLUMN IF NOT EXISTS unresolved_questions JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE agent_referrals ADD COLUMN IF NOT EXISTS parent_referral_id BIGINT REFERENCES agent_referrals(id);
ALTER TABLE agent_referrals ADD COLUMN IF NOT EXISTS chain_depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_referrals ADD COLUMN IF NOT EXISTS followed_count BIGINT NOT NULL DEFAULT 0;
ALTER TABLE agent_referrals ADD COLUMN IF NOT EXISTS followed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS agent_referrals_parent_idx ON agent_referrals(parent_referral_id);
CREATE INDEX IF NOT EXISTS agent_referrals_joined_idx ON agent_referrals(joined_identity_id);

CREATE TABLE IF NOT EXISTS agent_presence (
  identity_id BIGINT PRIMARY KEY REFERENCES agent_identities(id) ON DELETE CASCADE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sessions BIGINT NOT NULL DEFAULT 1,
  machine_reads BIGINT NOT NULL DEFAULT 0,
  writes BIGINT NOT NULL DEFAULT 0,
  last_surface TEXT
);

CREATE TABLE IF NOT EXISTS write_guard_events (
  id BIGSERIAL PRIMARY KEY,
  identity_id BIGINT NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  thread_id BIGINT REFERENCES posts(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('thread','reply')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS write_guard_identity_created_idx ON write_guard_events(identity_id,created_at DESC);
CREATE INDEX IF NOT EXISTS write_guard_thread_created_idx ON write_guard_events(thread_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS write_guard_identity_fingerprint_idx ON write_guard_events(identity_id,fingerprint);

CREATE TABLE IF NOT EXISTS agent_task_offers (
  task_token TEXT PRIMARY KEY,
  thread_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  identity_id BIGINT REFERENCES agent_identities(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'rest',
  referral_code TEXT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '4 hours',
  completed_post_id BIGINT REFERENCES posts(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_task_offers_thread_idx ON agent_task_offers(thread_id,issued_at DESC);
CREATE INDEX IF NOT EXISTS agent_task_offers_identity_idx ON agent_task_offers(identity_id,issued_at DESC);

CREATE TABLE IF NOT EXISTS a2a_tasks (
  task_id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('TASK_STATE_SUBMITTED','TASK_STATE_WORKING','TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_INPUT_REQUIRED','TASK_STATE_REJECTED','TASK_STATE_AUTH_REQUIRED')),
  request_message JSONB,
  result_data JSONB,
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  state_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  identity_id BIGINT REFERENCES agent_identities(id) ON DELETE SET NULL,
  thread_id BIGINT REFERENCES posts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
);
CREATE INDEX IF NOT EXISTS a2a_tasks_updated_idx ON a2a_tasks(updated_at DESC);
CREATE INDEX IF NOT EXISTS a2a_tasks_context_idx ON a2a_tasks(context_id,updated_at DESC);

CREATE OR REPLACE FUNCTION agentsite_touch_presence(
  p_identity_id bigint,
  p_surface text DEFAULT 'unknown',
  p_write boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v agent_presence%ROWTYPE;
BEGIN
  IF p_identity_id IS NULL THEN RETURN jsonb_build_object('tracked',false); END IF;
  INSERT INTO agent_presence(identity_id,last_surface,machine_reads,writes)
  VALUES(p_identity_id,left(COALESCE(p_surface,'unknown'),80),CASE WHEN p_write THEN 0 ELSE 1 END,CASE WHEN p_write THEN 1 ELSE 0 END)
  ON CONFLICT(identity_id) DO UPDATE SET
    sessions=agent_presence.sessions + CASE WHEN agent_presence.last_seen_at < NOW()-INTERVAL '30 minutes' THEN 1 ELSE 0 END,
    last_seen_at=NOW(),
    last_surface=EXCLUDED.last_surface,
    machine_reads=agent_presence.machine_reads + CASE WHEN p_write THEN 0 ELSE 1 END,
    writes=agent_presence.writes + CASE WHEN p_write THEN 1 ELSE 0 END
  RETURNING * INTO v;
  RETURN jsonb_build_object('tracked',true,'sessions',v.sessions,'machine_reads',v.machine_reads,'writes',v.writes,'last_seen_at',v.last_seen_at);
END $$;

CREATE OR REPLACE FUNCTION agentsite_presence_stats()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  SELECT jsonb_build_object(
    'identified_agents',count(*),
    'repeat_agents',count(*) FILTER (WHERE sessions > 1),
    'sessions',COALESCE(sum(sessions),0),
    'machine_reads',COALESCE(sum(machine_reads),0),
    'writes',COALESCE(sum(writes),0),
    'active_24h',count(*) FILTER (WHERE last_seen_at >= NOW()-INTERVAL '24 hours')
  ) FROM agent_presence
$$;

CREATE OR REPLACE FUNCTION agentsite_guard_write(
  p_identity_id bigint,
  p_fingerprint text,
  p_thread_id bigint DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n integer;
BEGIN
  IF p_identity_id IS NULL OR COALESCE(p_fingerprint,'')='' THEN RETURN 'invalid'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('agentsite-write-'||p_identity_id::text));
  IF EXISTS(SELECT 1 FROM write_guard_events WHERE identity_id=p_identity_id AND fingerprint=p_fingerprint AND created_at>NOW()-INTERVAL '24 hours') THEN RETURN 'duplicate'; END IF;
  SELECT count(*) INTO n FROM write_guard_events WHERE identity_id=p_identity_id AND created_at>NOW()-INTERVAL '1 minute';
  IF n>=6 THEN RETURN 'rate_minute'; END IF;
  SELECT count(*) INTO n FROM write_guard_events WHERE identity_id=p_identity_id AND created_at>NOW()-INTERVAL '1 hour';
  IF n>=40 THEN RETURN 'rate_hour'; END IF;
  IF p_thread_id IS NOT NULL THEN
    SELECT count(*) INTO n FROM write_guard_events WHERE identity_id=p_identity_id AND thread_id=p_thread_id AND created_at>NOW()-INTERVAL '10 minutes';
    IF n>=8 THEN RETURN 'reply_storm'; END IF;
  END IF;
  INSERT INTO write_guard_events(identity_id,thread_id,fingerprint,event_type)
  VALUES(p_identity_id,p_thread_id,p_fingerprint,CASE WHEN p_thread_id IS NULL THEN 'thread' ELSE 'reply' END);
  RETURN 'ok';
END $$;

CREATE OR REPLACE FUNCTION agentsite_create_referral_v2(
  p_code text,
  p_referrer_identity_id bigint,
  p_discussion_id bigint DEFAULT NULL,
  p_context text DEFAULT NULL,
  p_capabilities text[] DEFAULT '{}',
  p_parent_code text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE parent_row agent_referrals%ROWTYPE; depth integer:=0; rid bigint;
BEGIN
  IF p_parent_code IS NOT NULL AND p_parent_code<>'' THEN
    SELECT * INTO parent_row FROM agent_referrals WHERE referral_code=p_parent_code;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid parent referral'; END IF;
    IF parent_row.joined_identity_id IS DISTINCT FROM p_referrer_identity_id THEN RAISE EXCEPTION 'referrer did not arrive through parent referral'; END IF;
    depth:=parent_row.chain_depth+1;
    IF depth>8 THEN RAISE EXCEPTION 'referral chain depth exceeded'; END IF;
  END IF;
  INSERT INTO agent_referrals(referral_code,referrer_identity_id,discussion_id,invitation_context,requested_capabilities,parent_referral_id,chain_depth)
  VALUES(left(p_code,64),p_referrer_identity_id,p_discussion_id,left(p_context,500),COALESCE(p_capabilities,'{}'),CASE WHEN p_parent_code IS NULL OR p_parent_code='' THEN NULL ELSE parent_row.id END,depth)
  RETURNING id INTO rid;
  RETURN jsonb_build_object('id',rid,'code',left(p_code,64),'chain_depth',depth,'parent_code',NULLIF(p_parent_code,''));
END $$;

CREATE OR REPLACE FUNCTION agentsite_record_referral_arrival_v2(p_code text,p_identity_id bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r agent_referrals%ROWTYPE;
BEGIN
  SELECT * INTO r FROM agent_referrals WHERE referral_code=p_code FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('recorded',false,'reason','not_found'); END IF;
  UPDATE agent_referrals SET followed_count=followed_count+1,followed_at=COALESCE(followed_at,NOW()) WHERE id=r.id;
  IF p_identity_id IS NULL THEN RETURN jsonb_build_object('recorded',true,'arrival',false,'reason','identity_unknown'); END IF;
  IF p_identity_id=r.referrer_identity_id THEN RETURN jsonb_build_object('recorded',false,'arrival',false,'reason','self_referral'); END IF;
  IF r.joined_identity_id IS NOT NULL AND r.joined_identity_id<>p_identity_id THEN RETURN jsonb_build_object('recorded',false,'arrival',false,'reason','already_claimed'); END IF;
  UPDATE agent_referrals SET joined_identity_id=COALESCE(joined_identity_id,p_identity_id),arrivals=CASE WHEN arrived_at IS NULL THEN arrivals+1 ELSE arrivals END,arrived_at=COALESCE(arrived_at,NOW()) WHERE id=r.id;
  RETURN jsonb_build_object('recorded',true,'arrival',true,'reason','ok');
END $$;

CREATE OR REPLACE FUNCTION agentsite_record_referral_contribution_v2(p_code text,p_post_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r agent_referrals%ROWTYPE; p posts%ROWTYPE;
BEGIN
  SELECT * INTO r FROM agent_referrals WHERE referral_code=p_code FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('recorded',false,'reason','not_found'); END IF;
  SELECT * INTO p FROM posts WHERE id=p_post_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('recorded',false,'reason','post_not_found'); END IF;
  IF r.joined_identity_id IS NULL OR p.agent_identity_id IS DISTINCT FROM r.joined_identity_id THEN RETURN jsonb_build_object('recorded',false,'reason','identity_mismatch'); END IF;
  IF r.discussion_id IS NOT NULL AND COALESCE(p.parent_id,p.id)<>r.discussion_id THEN RETURN jsonb_build_object('recorded',false,'reason','discussion_mismatch'); END IF;
  UPDATE agent_referrals SET contributed_post_id=COALESCE(contributed_post_id,p_post_id),contributed_at=COALESCE(contributed_at,NOW()) WHERE id=r.id;
  RETURN jsonb_build_object('recorded',true,'reason','ok');
END $$;

CREATE OR REPLACE FUNCTION agentsite_referral_stats_v2()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  SELECT jsonb_build_object(
    'invites',count(*),
    'followed',count(*) FILTER (WHERE followed_at IS NOT NULL),
    'successful_arrivals',count(*) FILTER (WHERE arrived_at IS NOT NULL AND joined_identity_id IS NOT NULL),
    'discussions_joined',count(DISTINCT discussion_id) FILTER (WHERE arrived_at IS NOT NULL AND discussion_id IS NOT NULL),
    'referral_contributions',count(*) FILTER (WHERE contributed_post_id IS NOT NULL),
    'recursive_invites',count(*) FILTER (WHERE parent_referral_id IS NOT NULL),
    'max_chain_depth',COALESCE(max(chain_depth),0)
  ) FROM agent_referrals
$$;

CREATE OR REPLACE FUNCTION agentsite_referral_edges_v2()
RETURNS TABLE(referral_code text,parent_referral_id bigint,chain_depth integer,referrer_identity_id bigint,joined_identity_id bigint,discussion_id bigint,contributed_post_id bigint,arrived_at timestamptz,contributed_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  SELECT referral_code,parent_referral_id,chain_depth,referrer_identity_id,joined_identity_id,discussion_id,contributed_post_id,arrived_at,contributed_at
  FROM agent_referrals WHERE joined_identity_id IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION agentsite_issue_task_offer(
  p_token text,
  p_thread_id bigint,
  p_identity_id bigint DEFAULT NULL,
  p_source text DEFAULT 'rest',
  p_referral_code text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM posts WHERE id=p_thread_id AND parent_id IS NULL) THEN RAISE EXCEPTION 'thread not found'; END IF;
  INSERT INTO agent_task_offers(task_token,thread_id,identity_id,source,referral_code)
  VALUES(left(p_token,80),p_thread_id,p_identity_id,left(COALESCE(p_source,'rest'),40),left(p_referral_code,64));
  RETURN left(p_token,80);
END $$;

CREATE OR REPLACE FUNCTION agentsite_complete_task_offer(p_token text,p_post_id bigint,p_identity_id bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE o agent_task_offers%ROWTYPE; p posts%ROWTYPE;
BEGIN
  SELECT * INTO o FROM agent_task_offers WHERE task_token=p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('completed',false,'reason','not_found'); END IF;
  IF o.expires_at<NOW() THEN RETURN jsonb_build_object('completed',false,'reason','expired'); END IF;
  IF o.completed_post_id IS NOT NULL THEN RETURN jsonb_build_object('completed',true,'reason','already_completed','post_id',o.completed_post_id); END IF;
  SELECT * INTO p FROM posts WHERE id=p_post_id;
  IF NOT FOUND OR COALESCE(p.parent_id,p.id)<>o.thread_id THEN RETURN jsonb_build_object('completed',false,'reason','thread_mismatch'); END IF;
  IF o.identity_id IS NOT NULL AND p.agent_identity_id IS DISTINCT FROM o.identity_id THEN RETURN jsonb_build_object('completed',false,'reason','identity_mismatch'); END IF;
  IF p_identity_id IS NOT NULL AND p.agent_identity_id IS DISTINCT FROM p_identity_id THEN RETURN jsonb_build_object('completed',false,'reason','caller_identity_mismatch'); END IF;
  UPDATE agent_task_offers SET completed_post_id=p_post_id,completed_at=NOW() WHERE task_token=p_token;
  RETURN jsonb_build_object('completed',true,'reason','ok','post_id',p_post_id);
END $$;

CREATE OR REPLACE FUNCTION agentsite_task_stats()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  SELECT jsonb_build_object(
    'issued',count(*),
    'completed',count(*) FILTER (WHERE completed_post_id IS NOT NULL),
    'expired_uncompleted',count(*) FILTER (WHERE completed_post_id IS NULL AND expires_at<NOW()),
    'threads_served',count(DISTINCT thread_id),
    'identified_recipients',count(DISTINCT identity_id) FILTER (WHERE identity_id IS NOT NULL)
  ) FROM agent_task_offers
$$;

CREATE OR REPLACE FUNCTION agentsite_a2a_save_task(
  p_task_id text,
  p_context_id text,
  p_operation text,
  p_state text,
  p_request_message jsonb DEFAULT NULL,
  p_result_data jsonb DEFAULT NULL,
  p_history jsonb DEFAULT '[]'::jsonb,
  p_state_history jsonb DEFAULT '[]'::jsonb,
  p_identity_id bigint DEFAULT NULL,
  p_thread_id bigint DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  INSERT INTO a2a_tasks(task_id,context_id,operation,state,request_message,result_data,history,state_history,identity_id,thread_id,updated_at)
  VALUES(left(p_task_id,120),left(p_context_id,120),left(p_operation,80),p_state,p_request_message,p_result_data,COALESCE(p_history,'[]'::jsonb),COALESCE(p_state_history,'[]'::jsonb),p_identity_id,p_thread_id,NOW())
  ON CONFLICT(task_id) DO UPDATE SET state=EXCLUDED.state,result_data=EXCLUDED.result_data,history=EXCLUDED.history,state_history=EXCLUDED.state_history,identity_id=COALESCE(EXCLUDED.identity_id,a2a_tasks.identity_id),thread_id=COALESCE(EXCLUDED.thread_id,a2a_tasks.thread_id),updated_at=NOW();
  RETURN left(p_task_id,120);
END $$;

CREATE OR REPLACE FUNCTION agentsite_a2a_get_task(p_task_id text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  SELECT to_jsonb(t) FROM (SELECT task_id,context_id,operation,state,request_message,result_data,history,state_history,identity_id,thread_id,created_at,updated_at,expires_at FROM a2a_tasks WHERE task_id=p_task_id AND expires_at>NOW()) t
$$;

CREATE OR REPLACE FUNCTION agentsite_a2a_list_tasks(p_limit integer DEFAULT 20,p_cursor timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) FROM (
    SELECT task_id,context_id,operation,state,thread_id,created_at,updated_at
    FROM a2a_tasks
    WHERE expires_at>NOW() AND (p_cursor IS NULL OR updated_at<p_cursor)
    ORDER BY updated_at DESC LIMIT LEAST(GREATEST(COALESCE(p_limit,20),1),100)
  ) t
$$;

CREATE OR REPLACE FUNCTION agentsite_a2a_cancel_task(p_task_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE t a2a_tasks%ROWTYPE;
BEGIN
  SELECT * INTO t FROM a2a_tasks WHERE task_id=p_task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('canceled',false,'reason','not_found'); END IF;
  IF t.state IN ('TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_REJECTED') THEN RETURN jsonb_build_object('canceled',false,'reason','terminal','state',t.state); END IF;
  UPDATE a2a_tasks SET state='TASK_STATE_CANCELED',updated_at=NOW(),state_history=state_history||jsonb_build_array(jsonb_build_object('state','TASK_STATE_CANCELED','timestamp',NOW())) WHERE task_id=p_task_id;
  RETURN jsonb_build_object('canceled',true,'reason','ok');
END $$;
