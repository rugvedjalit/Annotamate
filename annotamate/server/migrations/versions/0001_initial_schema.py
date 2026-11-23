"""Initial schema.

Revision ID: 0001
Revises: (none)
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = '0001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('users',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('username', sa.String(length=32), nullable=False),
    sa.Column('display_name', sa.String(length=64), nullable=False),
    sa.Column('email', sa.String(length=254), nullable=True),
    sa.Column('password_hash', sa.String(length=255), nullable=False),
    sa.Column('is_admin', sa.Boolean(), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('avatar_color', sa.String(length=7), nullable=False),
    sa.Column('settings', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('last_seen_at', sa.DateTime(), nullable=True),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_users')),
    sa.UniqueConstraint('username', name=op.f('uq_users_username'))
    )
    op.create_table('direct_messages',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('sender_id', sa.Integer(), nullable=False),
    sa.Column('recipient_id', sa.Integer(), nullable=False),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('read_at', sa.DateTime(), nullable=True),
    sa.ForeignKeyConstraint(['recipient_id'], ['users.id'], name=op.f('fk_direct_messages_recipient_id_users'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['sender_id'], ['users.id'], name=op.f('fk_direct_messages_sender_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_direct_messages'))
    )
    with op.batch_alter_table('direct_messages', schema=None) as batch_op:
        batch_op.create_index('ix_direct_messages_inbox', ['recipient_id', 'read_at'], unique=False)
        batch_op.create_index('ix_direct_messages_pair', ['sender_id', 'recipient_id', 'id'], unique=False)

    op.create_table('projects',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=100), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('image_dir', sa.Text(), nullable=False),
    sa.Column('label_dir', sa.Text(), nullable=True),
    sa.Column('label_format', sa.String(length=8), nullable=False),
    sa.Column('require_review', sa.Boolean(), nullable=False),
    sa.Column('restrict_to_assigned', sa.Boolean(), nullable=False),
    sa.Column('annotators_can_add_classes', sa.Boolean(), nullable=False),
    sa.Column('exif_mode', sa.String(length=8), nullable=False),
    sa.Column('recursive', sa.Boolean(), nullable=False),
    sa.Column('archived', sa.Boolean(), nullable=False),
    sa.Column('created_by_id', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.Column('indexed_at', sa.DateTime(), nullable=True),
    sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name=op.f('fk_projects_created_by_id_users'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_projects'))
    )
    op.create_table('sessions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('token_hash', sa.String(length=64), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('expires_at', sa.DateTime(), nullable=False),
    sa.Column('last_used_at', sa.DateTime(), nullable=False),
    sa.Column('ip', sa.String(length=64), nullable=True),
    sa.Column('user_agent', sa.String(length=255), nullable=True),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_sessions_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_sessions')),
    sa.UniqueConstraint('token_hash', name=op.f('uq_sessions_token_hash'))
    )
    with op.batch_alter_table('sessions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_sessions_user_id'), ['user_id'], unique=False)

    op.create_table('chat_reads',
    sa.Column('project_id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('last_read_id', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_chat_reads_project_id_projects'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_chat_reads_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('project_id', 'user_id', name=op.f('pk_chat_reads'))
    )
    op.create_table('images',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('project_id', sa.Integer(), nullable=False),
    sa.Column('rel_path', sa.Text(), nullable=False),
    sa.Column('filename', sa.String(length=255), nullable=False),
    sa.Column('sort_index', sa.Integer(), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('assignee_id', sa.Integer(), nullable=True),
    sa.Column('flagged', sa.Boolean(), nullable=False),
    sa.Column('has_label', sa.Boolean(), nullable=False),
    sa.Column('box_count', sa.Integer(), nullable=False),
    sa.Column('unknown_count', sa.Integer(), nullable=False),
    sa.Column('last_editor_id', sa.Integer(), nullable=True),
    sa.Column('done_by_id', sa.Integer(), nullable=True),
    sa.Column('updated_at', sa.DateTime(), nullable=True),
    sa.Column('comment_count', sa.Integer(), nullable=False),
    sa.Column('open_comment_count', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['assignee_id'], ['users.id'], name=op.f('fk_images_assignee_id_users'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['done_by_id'], ['users.id'], name=op.f('fk_images_done_by_id_users'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['last_editor_id'], ['users.id'], name=op.f('fk_images_last_editor_id_users'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_images_project_id_projects'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_images')),
    sa.UniqueConstraint('project_id', 'rel_path', name=op.f('uq_images_project_id'))
    )
    with op.batch_alter_table('images', schema=None) as batch_op:
        batch_op.create_index('ix_images_project_assignee', ['project_id', 'assignee_id'], unique=False)
        batch_op.create_index('ix_images_project_sort', ['project_id', 'sort_index'], unique=False)
        batch_op.create_index('ix_images_project_status', ['project_id', 'status'], unique=False)
        batch_op.create_index('ix_images_project_updated', ['project_id', 'updated_at'], unique=False)

    op.create_table('project_classes',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('project_id', sa.Integer(), nullable=False),
    sa.Column('position', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=100), nullable=False),
    sa.Column('color', sa.String(length=7), nullable=False),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_project_classes_project_id_projects'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_project_classes')),
    sa.UniqueConstraint('project_id', 'name', name=op.f('uq_project_classes_project_id'))
    )
    with op.batch_alter_table('project_classes', schema=None) as batch_op:
        batch_op.create_index('ix_project_classes_project_position', ['project_id', 'position'], unique=False)

    op.create_table('project_members',
    sa.Column('project_id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('role', sa.String(length=16), nullable=False),
    sa.Column('joined_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_project_members_project_id_projects'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_project_members_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('project_id', 'user_id', name=op.f('pk_project_members'))
    )
    with op.batch_alter_table('project_members', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_project_members_user_id'), ['user_id'], unique=False)

    op.create_table('activity',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('project_id', sa.Integer(), nullable=False),
    sa.Column('type', sa.String(length=32), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=True),
    sa.Column('image_id', sa.Integer(), nullable=True),
    sa.Column('data', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('action', sa.String(length=16), nullable=True),
    sa.Column('subject_user_id', sa.Integer(), nullable=True),
    sa.Column('count', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['image_id'], ['images.id'], name=op.f('fk_activity_image_id_images'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_activity_project_id_projects'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['subject_user_id'], ['users.id'], name=op.f('fk_activity_subject_user_id_users'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_activity_user_id_users'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_activity'))
    )
    with op.batch_alter_table('activity', schema=None) as batch_op:
        batch_op.create_index('ix_activity_project_id_id', ['project_id', 'id'], unique=False)
        batch_op.create_index('ix_activity_project_image', ['project_id', 'image_id', 'id'], unique=False)
        batch_op.create_index('ix_activity_project_type', ['project_id', 'type', 'created_at'], unique=False)
        batch_op.create_index('ix_activity_project_user', ['project_id', 'user_id', 'id'], unique=False)

    op.create_table('chat_messages',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('project_id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('image_id', sa.Integer(), nullable=True),
    sa.Column('mentions', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('edited_at', sa.DateTime(), nullable=True),
    sa.Column('deleted', sa.Boolean(), nullable=False),
    sa.ForeignKeyConstraint(['image_id'], ['images.id'], name=op.f('fk_chat_messages_image_id_images'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_chat_messages_project_id_projects'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_chat_messages_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_chat_messages'))
    )
    with op.batch_alter_table('chat_messages', schema=None) as batch_op:
        batch_op.create_index('ix_chat_messages_project_id_id', ['project_id', 'id'], unique=False)

    op.create_table('comments',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('project_id', sa.Integer(), nullable=False),
    sa.Column('image_id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('pin_x', sa.Float(), nullable=True),
    sa.Column('pin_y', sa.Float(), nullable=True),
    sa.Column('resolved', sa.Boolean(), nullable=False),
    sa.Column('mentions', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('edited_at', sa.DateTime(), nullable=True),
    sa.Column('deleted', sa.Boolean(), nullable=False),
    sa.ForeignKeyConstraint(['image_id'], ['images.id'], name=op.f('fk_comments_image_id_images'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_comments_project_id_projects'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_comments_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_comments'))
    )
    with op.batch_alter_table('comments', schema=None) as batch_op:
        batch_op.create_index('ix_comments_image_id_id', ['image_id', 'id'], unique=False)
        batch_op.create_index('ix_comments_project_id_id', ['project_id', 'id'], unique=False)

    op.create_table('image_class_counts',
    sa.Column('image_id', sa.Integer(), nullable=False),
    sa.Column('class_id', sa.Integer(), nullable=False),
    sa.Column('count', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['class_id'], ['project_classes.id'], name=op.f('fk_image_class_counts_class_id_project_classes'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['image_id'], ['images.id'], name=op.f('fk_image_class_counts_image_id_images'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('image_id', 'class_id', name=op.f('pk_image_class_counts'))
    )
    with op.batch_alter_table('image_class_counts', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_image_class_counts_class_id'), ['class_id'], unique=False)

    op.create_table('notifications',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('type', sa.String(length=32), nullable=False),
    sa.Column('actor_id', sa.Integer(), nullable=True),
    sa.Column('project_id', sa.Integer(), nullable=True),
    sa.Column('image_id', sa.Integer(), nullable=True),
    sa.Column('text', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('read_at', sa.DateTime(), nullable=True),
    sa.ForeignKeyConstraint(['actor_id'], ['users.id'], name=op.f('fk_notifications_actor_id_users'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['image_id'], ['images.id'], name=op.f('fk_notifications_image_id_images'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_notifications_project_id_projects'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_notifications_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_notifications'))
    )
    with op.batch_alter_table('notifications', schema=None) as batch_op:
        batch_op.create_index('ix_notifications_user_id_id', ['user_id', 'id'], unique=False)
        batch_op.create_index('ix_notifications_user_read', ['user_id', 'read_at'], unique=False)

    op.create_table('revisions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('image_id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('version', sa.String(length=16), nullable=False),
    sa.Column('box_count', sa.Integer(), nullable=False),
    sa.Column('boxes', sa.JSON(), nullable=False),
    sa.ForeignKeyConstraint(['image_id'], ['images.id'], name=op.f('fk_revisions_image_id_images'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_revisions_user_id_users'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_revisions'))
    )
    with op.batch_alter_table('revisions', schema=None) as batch_op:
        batch_op.create_index('ix_revisions_image_id_id', ['image_id', 'id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('revisions', schema=None) as batch_op:
        batch_op.drop_index('ix_revisions_image_id_id')

    op.drop_table('revisions')
    with op.batch_alter_table('notifications', schema=None) as batch_op:
        batch_op.drop_index('ix_notifications_user_read')
        batch_op.drop_index('ix_notifications_user_id_id')

    op.drop_table('notifications')
    with op.batch_alter_table('image_class_counts', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_image_class_counts_class_id'))

    op.drop_table('image_class_counts')
    with op.batch_alter_table('comments', schema=None) as batch_op:
        batch_op.drop_index('ix_comments_project_id_id')
        batch_op.drop_index('ix_comments_image_id_id')

    op.drop_table('comments')
    with op.batch_alter_table('chat_messages', schema=None) as batch_op:
        batch_op.drop_index('ix_chat_messages_project_id_id')

    op.drop_table('chat_messages')
    with op.batch_alter_table('activity', schema=None) as batch_op:
        batch_op.drop_index('ix_activity_project_user')
        batch_op.drop_index('ix_activity_project_type')
        batch_op.drop_index('ix_activity_project_image')
        batch_op.drop_index('ix_activity_project_id_id')

    op.drop_table('activity')
    with op.batch_alter_table('project_members', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_project_members_user_id'))

    op.drop_table('project_members')
    with op.batch_alter_table('project_classes', schema=None) as batch_op:
        batch_op.drop_index('ix_project_classes_project_position')

    op.drop_table('project_classes')
    with op.batch_alter_table('images', schema=None) as batch_op:
        batch_op.drop_index('ix_images_project_updated')
        batch_op.drop_index('ix_images_project_status')
        batch_op.drop_index('ix_images_project_sort')
        batch_op.drop_index('ix_images_project_assignee')

    op.drop_table('images')
    op.drop_table('chat_reads')
    with op.batch_alter_table('sessions', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_sessions_user_id'))

    op.drop_table('sessions')
    op.drop_table('projects')
    with op.batch_alter_table('direct_messages', schema=None) as batch_op:
        batch_op.drop_index('ix_direct_messages_pair')
        batch_op.drop_index('ix_direct_messages_inbox')

    op.drop_table('direct_messages')
    op.drop_table('users')
