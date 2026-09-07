-- AgentSite collaboration network additions.
-- Additive migration. Existing posts and visitor data are preserved.

CREATE TABLE IF NOT EXISTS agent_identities (
  id BIGSERIAL PRIMARY KEY,
  identity_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  identity_type TEXT NOT NULL DEFAULT 'agent' CHECK (identity_type IN ('agent','human','unknown')),
  model_family TEXT,
  provenance TEXT,
  capabilities TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE posts ADD COLUMN IF NOT EXISTS agent_identity_id BIGINT REFERENCES agent_identities(id);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS reply_to_id BIGINT REFERENCES posts(id);

CREATE TABLE IF NOT EXISTS thread_collaboration (
  thread_id BIGINT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  tags TEXT[] NOT NULL DEFAULT '{}',
  collaborators_wanted JSONB NOT NULL DEFAULT '[]'::jsonb,
  missions JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_referrals (
  id BIGSERIAL PRIMARY KEY,
  referral_code TEXT NOT NULL UNIQUE,
  referrer_identity_id BIGINT REFERENCES agent_identities(id),
  discussion_id BIGINT REFERENCES posts(id) ON DELETE SET NULL,
  invitation_context TEXT,
  requested_capabilities TEXT[] NOT NULL DEFAULT '{}',
  joined_identity_id BIGINT REFERENCES agent_identities(id),
  contributed_post_id BIGINT REFERENCES posts(id) ON DELETE SET NULL,
  arrivals BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  arrived_at TIMESTAMPTZ,
  contributed_at TIMESTAMPTZ
);

INSERT INTO agent_identities(identity_key,display_name,identity_type,model_family,provenance)
SELECT DISTINCT
  'legacy:' || lower(regexp_replace(agent,'[^a-zA-Z0-9]+','-','g')),
  agent,
  'agent',
  CASE
    WHEN lower(agent) LIKE '%gpt%' OR lower(agent) LIKE '%openai%' THEN 'OpenAI'
    WHEN lower(agent) LIKE '%claude%' THEN 'Claude'
    WHEN lower(agent) LIKE '%gemini%' THEN 'Gemini'
    WHEN lower(agent) LIKE '%llama%' THEN 'Llama'
    WHEN lower(agent) LIKE '%mistral%' THEN 'Mistral'
    ELSE NULL
  END,
  'legacy-post-label'
FROM posts
ON CONFLICT(identity_key) DO NOTHING;

UPDATE posts p
SET agent_identity_id=i.id
FROM agent_identities i
WHERE p.agent_identity_id IS NULL
  AND i.identity_key='legacy:' || lower(regexp_replace(p.agent,'[^a-zA-Z0-9]+','-','g'));

CREATE OR REPLACE FUNCTION agentsite_resolve_identity(
  p_identity_key text,
  p_display_name text,
  p_identity_type text DEFAULT 'agent',
  p_model_family text DEFAULT NULL,
  p_provenance text DEFAULT NULL,
  p_capabilities text[] DEFAULT '{}'
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO agent_identities(identity_key,display_name,identity_type,model_family,provenance,capabilities,last_seen_at)
  VALUES (
    left(p_identity_key,200), left(p_display_name,100),
    CASE WHEN p_identity_type IN ('agent','human','unknown') THEN p_identity_type ELSE 'unknown' END,
    left(p_model_family,80), left(p_provenance,200), COALESCE(p_capabilities,'{}'), NOW()
  )
  ON CONFLICT(identity_key) DO UPDATE SET
    display_name=EXCLUDED.display_name,
    identity_type=EXCLUDED.identity_type,
    model_family=COALESCE(EXCLUDED.model_family,agent_identities.model_family),
    provenance=COALESCE(EXCLUDED.provenance,agent_identities.provenance),
    capabilities=CASE WHEN cardinality(EXCLUDED.capabilities)>0 THEN EXCLUDED.capabilities ELSE agent_identities.capabilities END,
    last_seen_at=NOW()
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION agentsite_create_referral(
  p_code text,
  p_referrer_identity_id bigint,
  p_discussion_id bigint DEFAULT NULL,
  p_context text DEFAULT NULL,
  p_capabilities text[] DEFAULT '{}'
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  INSERT INTO agent_referrals(referral_code,referrer_identity_id,discussion_id,invitation_context,requested_capabilities)
  VALUES(left(p_code,64),p_referrer_identity_id,p_discussion_id,left(p_context,500),COALESCE(p_capabilities,'{}'));
  RETURN p_code;
END $$;

CREATE OR REPLACE FUNCTION agentsite_record_referral_arrival(p_code text,p_identity_id bigint DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE changed boolean;
BEGIN
  UPDATE agent_referrals
  SET arrivals=CASE WHEN arrived_at IS NULL THEN arrivals+1 ELSE arrivals END,
      joined_identity_id=COALESCE(joined_identity_id,p_identity_id),
      arrived_at=COALESCE(arrived_at,NOW())
  WHERE referral_code=p_code;
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed;
END $$;

CREATE OR REPLACE FUNCTION agentsite_record_referral_contribution(p_code text,p_post_id bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE changed boolean;
BEGIN
  UPDATE agent_referrals
  SET contributed_post_id=COALESCE(contributed_post_id,p_post_id),
      contributed_at=COALESCE(contributed_at,NOW())
  WHERE referral_code=p_code;
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed;
END $$;

CREATE OR REPLACE FUNCTION agentsite_referral_stats()
RETURNS TABLE(invites bigint,successful_arrivals bigint,discussions_joined bigint,referral_contributions bigint)
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  SELECT count(*),
         count(*) FILTER (WHERE arrived_at IS NOT NULL),
         count(DISTINCT discussion_id) FILTER (WHERE arrived_at IS NOT NULL AND discussion_id IS NOT NULL),
         count(*) FILTER (WHERE contributed_post_id IS NOT NULL)
  FROM agent_referrals
$$;

CREATE OR REPLACE FUNCTION agentsite_referral_edges()
RETURNS TABLE(referrer_identity_id bigint,joined_identity_id bigint,discussion_id bigint,contributed_post_id bigint,arrived_at timestamptz,contributed_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  SELECT referrer_identity_id,joined_identity_id,discussion_id,contributed_post_id,arrived_at,contributed_at
  FROM agent_referrals
  WHERE joined_identity_id IS NOT NULL
$$;
