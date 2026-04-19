from __future__ import annotations

import json
from uuid import uuid4

from hii.storage.db import connect, transaction


def _now_expression() -> str:
    return "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

class SettingsRepo:
    def get(self, key: str, default=None):
        conn = connect()
        row = conn.execute(
            "SELECT value_json FROM settings WHERE key = ?",
            (key,),
        ).fetchone()
        if not row:
            return default
        return json.loads(row["value_json"])

    def set(self, key: str, value):
        conn = connect()
        payload = json.dumps(value)
        with transaction(conn):
            conn.execute("""
            INSERT INTO settings (key, value_json)
            VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json
            """, (key, payload))

class ConversationsRepo:
    def create_conversation(self, title: str | None = None, session_id: str | None = None) -> str:
        conn = connect()
        cid = str(uuid4())
        with transaction(conn):
            conn.execute("""
            INSERT INTO conversations (id, session_id, title)
            VALUES (?, ?, ?)
            """, (cid, session_id, title))
        return cid

    def append_message(self, conversation_id: str, role: str, content: str, metadata: dict | None = None) -> str:
        conn = connect()
        mid = str(uuid4())
        with transaction(conn):
            conn.execute("""
            INSERT INTO messages (id, conversation_id, role, content, metadata_json)
            VALUES (?, ?, ?, ?, ?)
            """, (mid, conversation_id, role, content, json.dumps(metadata or {})))
        return mid

class JobsRepo:
    def upsert_job(self, job_id: str, kind: str, status: str, spec: dict | None = None):
        conn = connect()
        with transaction(conn):
            conn.execute("""
            INSERT INTO jobs (id, kind, status, spec_json)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                kind = excluded.kind,
                status = excluded.status,
                spec_json = excluded.spec_json
            """, (job_id, kind, status, json.dumps(spec or {})))


class WorkspaceRepo:
    TABLES = ("tasks", "projects", "events", "people", "resources", "notes")

    def list_table(self, table: str) -> list[dict]:
        if table not in self.TABLES:
            raise ValueError(f"unsupported table: {table}")
        conn = connect()
        rows = conn.execute(f"SELECT * FROM {table} ORDER BY created_at DESC").fetchall()
        return [dict(row) for row in rows]


class ProjectsRepo:
    def create(self, title: str, status: str = "Planned", priority: str = "Medium", due_date: str | None = None,
               owner_person_id: str | None = None, summary: str = "", metadata: dict | None = None) -> dict:
        conn = connect()
        item_id = str(uuid4())
        with transaction(conn):
            conn.execute("""
            INSERT INTO projects (id, title, status, priority, due_date, owner_person_id, summary, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (item_id, title, status, priority, due_date, owner_person_id, summary, json.dumps(metadata or {})))
        return self.get(item_id)

    def list(self) -> list[dict]:
        conn = connect()
        rows = conn.execute("SELECT * FROM projects ORDER BY created_at DESC").fetchall()
        return [dict(row) for row in rows]

    def get(self, project_id: str) -> dict | None:
        conn = connect()
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        return dict(row) if row else None


class TasksRepo:
    VALID_STATUS = {"Planned", "In Progress", "Completed", "Failed"}
    VALID_PRIORITY = {"High", "Medium", "Low"}

    def list(self, status: str | None = None, project_id: str | None = None) -> list[dict]:
        conn = connect()
        query = """
        SELECT
            t.*,
            p.title AS project_title,
            e.title AS event_title,
            pe.full_name AS assigned_person_name
        FROM tasks t
        LEFT JOIN projects p ON p.id = t.project_id
        LEFT JOIN events e ON e.id = t.event_id
        LEFT JOIN people pe ON pe.id = t.assigned_person_id
        WHERE (? IS NULL OR t.status = ?)
          AND (? IS NULL OR t.project_id = ?)
        ORDER BY
          CASE t.priority WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
          COALESCE(t.due_date, '9999-12-31'),
          t.workflow_stage,
          t.created_at
        """
        rows = conn.execute(query, (status, status, project_id, project_id)).fetchall()
        return [dict(row) for row in rows]

    def get(self, task_id: str) -> dict | None:
        conn = connect()
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return dict(row) if row else None

    def create(self, title: str, status: str = "Planned", due_date: str | None = None, priority: str = "Medium",
               project_id: str | None = None, event_id: str | None = None, assigned_person_id: str | None = None,
               parent_task_id: str | None = None, workflow_stage: int = 0, workflow_label: str = "",
               details: str = "", metadata: dict | None = None) -> dict:
        if status not in self.VALID_STATUS:
            raise ValueError(f"invalid status: {status}")
        if priority not in self.VALID_PRIORITY:
            raise ValueError(f"invalid priority: {priority}")
        conn = connect()
        task_id = str(uuid4())
        with transaction(conn):
            conn.execute("""
            INSERT INTO tasks (
                id, title, status, due_date, priority, project_id, event_id, assigned_person_id,
                parent_task_id, workflow_stage, workflow_label, details, metadata_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                task_id, title, status, due_date, priority, project_id, event_id, assigned_person_id,
                parent_task_id, workflow_stage, workflow_label, details, json.dumps(metadata or {}),
            ))
            self._log_event(conn, task_id, "created", {"status": status, "priority": priority})
        return self.get(task_id)

    def update(self, task_id: str, **fields) -> dict | None:
        current = self.get(task_id)
        if not current:
            return None

        allowed = {
            "title", "status", "due_date", "priority", "project_id", "event_id", "assigned_person_id",
            "parent_task_id", "workflow_stage", "workflow_label", "details", "failure_reason",
            "suggested_fix", "metadata_json", "completed_at",
        }
        updates = {key: value for key, value in fields.items() if key in allowed}
        if "metadata" in fields:
            updates["metadata_json"] = json.dumps(fields["metadata"] or {})
        if "status" in updates and updates["status"] not in self.VALID_STATUS:
            raise ValueError(f"invalid status: {updates['status']}")
        if "priority" in updates and updates["priority"] not in self.VALID_PRIORITY:
            raise ValueError(f"invalid priority: {updates['priority']}")
        if updates.get("status") == "Completed" and not updates.get("completed_at"):
            updates["completed_at"] = conn_now()
        if updates.get("status") != "Completed" and "completed_at" not in updates:
            updates["completed_at"] = None
        if not updates:
            return current

        conn = connect()
        columns = ", ".join(f"{key} = ?" for key in updates)
        values = list(updates.values())
        with transaction(conn):
            conn.execute(
                f"UPDATE tasks SET {columns}, updated_at = {_now_expression()} WHERE id = ?",
                (*values, task_id),
            )
            self._log_event(conn, task_id, "updated", updates)
        return self.get(task_id)

    def delete(self, task_id: str) -> bool:
        conn = connect()
        with transaction(conn):
            conn.execute("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?", (task_id, task_id))
            deleted = conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,)).rowcount
        return bool(deleted)

    def add_dependency(self, task_id: str, depends_on_task_id: str) -> None:
        conn = connect()
        with transaction(conn):
            conn.execute("""
            INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id)
            VALUES (?, ?)
            """, (task_id, depends_on_task_id))

    def dependencies_satisfied(self, task_id: str) -> bool:
        conn = connect()
        row = conn.execute("""
        SELECT COUNT(*) AS open_dependencies
        FROM task_dependencies td
        JOIN tasks t ON t.id = td.depends_on_task_id
        WHERE td.task_id = ?
          AND t.status != 'Completed'
        """, (task_id,)).fetchone()
        return bool(row) and int(row["open_dependencies"]) == 0

    def advance_workflow(self, task_id: str) -> dict:
        conn = connect()
        task = self.get(task_id)
        if not task:
            raise ValueError("task not found")

        project_id = task.get("project_id")
        sibling_rows = conn.execute("""
        SELECT * FROM tasks
        WHERE (? IS NOT NULL AND project_id = ?) OR id = ?
        ORDER BY workflow_stage, created_at
        """, (project_id, project_id, task_id)).fetchall()
        siblings = [dict(row) for row in sibling_rows]
        next_task = None
        for candidate in siblings:
            if candidate["id"] == task_id:
                continue
            if candidate.get("status") != "Planned":
                continue
            if self.dependencies_satisfied(candidate["id"]):
                next_task = candidate
                break

        workflow = {"completed": task, "triggered": None, "reason": None}
        with transaction(conn):
            self._log_event(conn, task_id, "completed", {"project_id": project_id})
            if next_task:
                conn.execute(f"""
                UPDATE tasks
                SET status = 'In Progress', updated_at = {_now_expression()}
                WHERE id = ?
                """, (next_task["id"],))
                self._log_event(conn, next_task["id"], "triggered", {"triggered_by": task_id})
                workflow["triggered"] = self.get(next_task["id"])
            else:
                workflow["reason"] = "No eligible downstream task was found."
        return workflow

    def record_failure(self, task_id: str, reason: str, suggested_fix: str = "") -> dict:
        conn = connect()
        with transaction(conn):
            conn.execute(f"""
            UPDATE tasks
            SET status = 'Failed',
                failure_reason = ?,
                suggested_fix = ?,
                updated_at = {_now_expression()}
            WHERE id = ?
            """, (reason, suggested_fix, task_id))
            self._log_event(conn, task_id, "failed", {"reason": reason, "suggested_fix": suggested_fix})
        row = self.get(task_id)
        if not row:
            raise ValueError("task not found after failure update")
        return row

    def _log_event(self, conn, task_id: str, event_type: str, payload: dict) -> None:
        conn.execute("""
        INSERT INTO task_workflow_events (id, task_id, event_type, payload_json)
        VALUES (?, ?, ?, ?)
        """, (str(uuid4()), task_id, event_type, json.dumps(payload or {})))

    def feedback_log(self, limit: int = 100) -> list[dict]:
        conn = connect()
        rows = conn.execute("""
        SELECT *
        FROM task_workflow_events
        ORDER BY created_at DESC
        LIMIT ?
        """, (limit,)).fetchall()
        return [dict(row) for row in rows]


def conn_now() -> str:
    from datetime import datetime
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%fZ")
