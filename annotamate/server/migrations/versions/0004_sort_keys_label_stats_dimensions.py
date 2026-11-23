"""Natural-sort keys, label file stats for incremental rescans, image dimensions and class-list versions.

``images``:

* ``sort_key`` replaces ``sort_index``: a byte string whose binary order is the natural order of ``rel_path``.
  The list is ordered by it, so adding images never renumbers the rest of the project. The three indexes that
  ended in ``sort_index`` end in ``sort_key`` now (``ix_images_project_sort`` also gains ``missing``).
* ``label_size``, ``label_mtime_ns``, ``counted_version``: the state of the label file (and of the class list)
  the stored counts were computed from; a rescan skips files for which nothing changed.
* ``width``, ``height``, ``file_size``, ``file_mtime_ns``: the image's pixel size, remembered with the state of
  the image file, so a COCO export does not open every image again.

``projects``: ``class_version`` and ``class_floor`` (see ``models.Project``).

Revision ID: 0004
Revises: 0003
"""

from __future__ import annotations

import re

import sqlalchemy as sa
from alembic import op

revision = '0004'
down_revision = '0003'
branch_labels = None
depends_on = None

_DIGITS = re.compile(r"(\d+)")
_BATCH = 1000


def _sort_key(text: str) -> bytes:
    """``core.scanning.natural_sort_key`` as it was when this migration was written."""
    out = bytearray()
    components = text.replace("\\", "/").split("/")
    last = len(components) - 1
    for n, component in enumerate(components):
        chunks = _DIGITS.split(component.casefold())
        final = len(chunks) - 1
        for i, chunk in enumerate(chunks):
            if i % 2:
                digits = str(int(chunk)).encode("ascii")
                out += len(digits).to_bytes(2, "big")
                out += digits
                continue
            for byte in chunk.encode("utf-8", "surrogatepass"):
                if byte < 4:
                    out.append(3)
                    out.append(byte + 1)
                else:
                    out.append(byte)
            out.append(2 if i < final else 1 if n < last else 0)
    out += text.encode("utf-8", "surrogatepass")
    return bytes(out)


_images = sa.table('images', sa.column('id', sa.Integer), sa.column('project_id', sa.Integer),
                   sa.column('rel_path', sa.Text), sa.column('missing', sa.Boolean),
                   sa.column('sort_key', sa.LargeBinary), sa.column('sort_index', sa.Integer))


def upgrade() -> None:
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.add_column(sa.Column('class_version', sa.Integer(), server_default='0', nullable=False))
        batch_op.add_column(sa.Column('class_floor', sa.Integer(), server_default='0', nullable=False))
    with op.batch_alter_table('images', schema=None) as batch_op:
        batch_op.add_column(sa.Column('sort_key', sa.LargeBinary(), nullable=True))
        batch_op.add_column(sa.Column('label_size', sa.BigInteger(), nullable=True))
        batch_op.add_column(sa.Column('label_mtime_ns', sa.BigInteger(), nullable=True))
        batch_op.add_column(sa.Column('counted_version', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column('width', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column('height', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column('file_size', sa.BigInteger(), nullable=True))
        batch_op.add_column(sa.Column('file_mtime_ns', sa.BigInteger(), nullable=True))

    conn = op.get_bind()
    store = (sa.update(_images).where(_images.c.id == sa.bindparam('_id'))
             .values(sort_key=sa.bindparam('_key')))
    last_id = 0
    while True:
        rows = conn.execute(sa.select(_images.c.id, _images.c.rel_path).where(_images.c.id > last_id)
                            .order_by(_images.c.id).limit(_BATCH)).all()
        if not rows:
            break
        conn.execute(store, [{'_id': r.id, '_key': _sort_key(r.rel_path)} for r in rows])
        last_id = rows[-1].id

    with op.batch_alter_table('images', schema=None) as batch_op:
        batch_op.drop_index('ix_images_project_sort')
        batch_op.drop_index('ix_images_project_missing_status_sort')
        batch_op.drop_index('ix_images_project_missing_assignee_sort')
        batch_op.alter_column('sort_key', existing_type=sa.LargeBinary(), nullable=False)
        batch_op.drop_column('sort_index')
        batch_op.create_index('ix_images_project_sort', ['project_id', 'missing', 'sort_key'], unique=False)
        batch_op.create_index('ix_images_project_missing_status_sort',
                              ['project_id', 'missing', 'status', 'sort_key'], unique=False)
        batch_op.create_index('ix_images_project_missing_assignee_sort',
                              ['project_id', 'missing', 'assignee_id', 'sort_key'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('images', schema=None) as batch_op:
        batch_op.add_column(sa.Column('sort_index', sa.Integer(), nullable=True))

    # ``sort_index`` was the 0-based position in natural order, missing images last.
    conn = op.get_bind()
    store = (sa.update(_images).where(_images.c.id == sa.bindparam('_id'))
             .values(sort_index=sa.bindparam('_pos')))
    for project_id in conn.execute(sa.select(_images.c.project_id).distinct()).scalars().all():
        ids = conn.execute(sa.select(_images.c.id).where(_images.c.project_id == project_id)
                           .order_by(_images.c.missing, _images.c.sort_key)).scalars().all()
        for start in range(0, len(ids), _BATCH):
            conn.execute(store, [{'_id': image_id, '_pos': start + n}
                                 for n, image_id in enumerate(ids[start:start + _BATCH])])

    with op.batch_alter_table('images', schema=None) as batch_op:
        batch_op.drop_index('ix_images_project_missing_assignee_sort')
        batch_op.drop_index('ix_images_project_missing_status_sort')
        batch_op.drop_index('ix_images_project_sort')
        batch_op.alter_column('sort_index', existing_type=sa.Integer(), nullable=False)
        batch_op.drop_column('file_mtime_ns')
        batch_op.drop_column('file_size')
        batch_op.drop_column('height')
        batch_op.drop_column('width')
        batch_op.drop_column('counted_version')
        batch_op.drop_column('label_mtime_ns')
        batch_op.drop_column('label_size')
        batch_op.drop_column('sort_key')
        batch_op.create_index('ix_images_project_sort', ['project_id', 'sort_index'], unique=False)
        batch_op.create_index('ix_images_project_missing_status_sort',
                              ['project_id', 'missing', 'status', 'sort_index'], unique=False)
        batch_op.create_index('ix_images_project_missing_assignee_sort',
                              ['project_id', 'missing', 'assignee_id', 'sort_index'], unique=False)
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.drop_column('class_floor')
        batch_op.drop_column('class_version')
