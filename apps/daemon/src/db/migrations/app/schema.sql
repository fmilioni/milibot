-- index workspaces_vm_port_base on workspaces
CREATE UNIQUE INDEX workspaces_vm_port_base ON workspaces (vm_port_base) WHERE vm_port_base IS NOT NULL;

-- table app_settings
CREATE TABLE app_settings (
key TEXT PRIMARY KEY,
value TEXT NOT NULL,
updated_at INTEGER NOT NULL
);

-- table workspaces
CREATE TABLE workspaces (
id TEXT PRIMARY KEY,
name TEXT NOT NULL,
color TEXT NOT NULL,
icon TEXT,
dir TEXT NOT NULL,
close_behavior TEXT NOT NULL DEFAULT 'keep_running'
CHECK (close_behavior IN ('keep_running', 'suspend_vm')),
position INTEGER NOT NULL DEFAULT 0,
vm_port_base INTEGER,
setup_step TEXT NOT NULL CHECK (setup_step IN ('providers', 'vm', 'login', 'done')),
last_running INTEGER NOT NULL DEFAULT 0,
created_at INTEGER NOT NULL,
last_opened_at INTEGER
);
