"""Indexes for status/assignee filters and counts, and for deleting images.

``images``: ``(project_id, missing, status, sort_index)`` and ``(project_id, missing, assignee_id, sort_index)``
replace ``(project_id, status)`` and ``(project_id, assignee_id)``. They match the list queries (visible images
of a project with a status or an assignee, in list order) and cover the per-project counts.

``activity``, ``notifications``, ``chat_messages``: an index on ``image_id``, so deleting an image (project
delete, pruning missing images) clears its references without scanning those tables.

Revision ID: 0003
Revises: 0002
"""

from __future__ import annotations

from alembic import op

revision = '0003'
down_revision = '0002'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('images', schema=None) as batch_op:
        batch_op.drop_index('ix_images_project_status')
        batch_op.drop_index('ix_images_project_assignee')
        batch_op.create_index('ix_images_project_missing_status_sort',
                              ['project_id', 'missing', 'status', 'sort_index'], unique=False)
        batch_op.create_index('ix_images_project_missing_assignee_sort',
                              ['project_id', 'missing', 'assignee_id', 'sort_index'], unique=False)
    with op.batch_alter_table('activity', schema=None) as batch_op:
        batch_op.create_index('ix_activity_image_id', ['image_id'], unique=False)
    with op.batch_alter_table('notifications', schema=None) as batch_op:
        batch_op.create_index('ix_notifications_image_id', ['image_id'], unique=False)
    with op.batch_alter_table('chat_messages', schema=None) as batch_op:
        batch_op.create_index('ix_chat_messages_image_id', ['image_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('chat_messages', schema=None) as batch_op:
        batch_op.drop_index('ix_chat_messages_image_id')
    with op.batch_alter_table('notifications', schema=None) as batch_op:
        batch_op.drop_index('ix_notifications_image_id')
    with op.batch_alter_table('activity', schema=None) as batch_op:
        batch_op.drop_index('ix_activity_image_id')
    with op.batch_alter_table('images', schema=None) as batch_op:
        batch_op.drop_index('ix_images_project_missing_assignee_sort')
        batch_op.drop_index('ix_images_project_missing_status_sort')
        batch_op.create_index('ix_images_project_assignee', ['project_id', 'assignee_id'], unique=False)
        batch_op.create_index('ix_images_project_status', ['project_id', 'status'], unique=False)
