CREATE TABLE tally (
  party_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (party_id, role_id, candidate_id)
);

INSERT INTO tally (party_id, role_id, candidate_id, n)
SELECT party_id, role_id, candidate_id, COUNT(*) FROM picks GROUP BY party_id, role_id, candidate_id;

CREATE TABLE ip_counts (
  key TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  n INTEGER NOT NULL
);

CREATE INDEX idx_ip_counts_day ON ip_counts (day);

DROP INDEX idx_votes_ip_day;
ALTER TABLE votes DROP COLUMN ip_hash;
ALTER TABLE votes DROP COLUMN day;

DROP INDEX idx_picks_role_candidate;
DROP INDEX idx_picks_party_role_candidate;
DROP INDEX idx_votes_party;
