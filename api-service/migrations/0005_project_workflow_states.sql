-- Persist the current parsed-script fingerprint used by creative workflow gates.
-- Idempotent: older Node releases may already have created this table.
CREATE TABLE IF NOT EXISTS project_workflow_states (
  project_id BIGINT UNSIGNED NOT NULL,
  parsed_script_fingerprint CHAR(64) DEFAULT NULL,
  parsed_at DATETIME DEFAULT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id),
  CONSTRAINT fk_project_workflow_state_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
