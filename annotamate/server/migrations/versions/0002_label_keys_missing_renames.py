"""Label keys, soft-deleted (missing) images and pending class renames.

Revision ID: 0002
Revises: 0001
"""

from __future__ import annotations

import os
import posixpath
import sys

import sqlalchemy as sa
from alembic import op

revision = '0002'
down_revision = '0001'
branch_labels = None
depends_on = None

# Same rule as ``services.paths.label_key`` when this migration was written (a rescan recomputes keys anyway):
# case is folded only on file systems that ignore it by default.
_CASE_INSENSITIVE = os.name == 'nt' or sys.platform == 'darwin'


def _label_key(rel_path: str) -> str:
    stem = posixpath.splitext(rel_path)[0]
    return stem.casefold() if _CASE_INSENSITIVE else stem


def upgrade() -> None:
    with op.batch_alter_table('images', schema=None) as batch_op:
        batch_op.add_column(sa.Column('label_key', sa.Text(), server_default='', nullable=False))
        batch_op.add_column(sa.Column('missing', sa.Boolean(), server_default=sa.false(), nullable=False))
    conn = op.get_bind()
    rows = conn.execute(sa.text('SELECT id, rel_path FROM images')).all()
    update = sa.text('UPDATE images SET label_key = :key WHERE id = :id')
    for start in range(0, len(rows), 1000):
        conn.execute(update, [{'id': r.id, 'key': _label_key(r.rel_path)}
                              for r in rows[start:start + 1000]])
    with op.batch_alter_table('images', schema=None) as batch_op:
        batch_op.create_index('ix_images_project_label_key', ['project_id', 'label_key'], unique=False)

    op.create_table('pending_renames',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('project_id', sa.Integer(), nullable=False),
    sa.Column('old_name', sa.String(length=100), nullable=False),
    sa.Column('new_name', sa.String(length=100), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_pending_renames_project_id_projects'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_pending_renames'))
    )
    with op.batch_alter_table('pending_renames', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_pending_renames_project_id'), ['project_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('pending_renames', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_pending_renames_project_id'))
    op.drop_table('pending_renames')
    with op.batch_alter_table('images', schema=None) as batch_op:
        batch_op.drop_index('ix_images_project_label_key')
        batch_op.drop_column('missing')
        batch_op.drop_column('label_key')
