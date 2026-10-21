CREATE TABLE votes (
  voter_id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_votes_ip_day ON votes (ip_hash, day);
CREATE INDEX idx_votes_party ON votes (party_id);

CREATE TABLE picks (
  voter_id TEXT NOT NULL REFERENCES votes (voter_id),
  party_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  PRIMARY KEY (voter_id, role_id)
);

CREATE INDEX idx_picks_role_candidate ON picks (role_id, candidate_id);
CREATE INDEX idx_picks_party_role_candidate ON picks (party_id, role_id, candidate_id);
