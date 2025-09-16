/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * Collaborative commenting and review system component suite for Jupyter notebooks.
 * Provides threaded discussions on notebook cells with markdown formatting, @-mentions,
 * comment resolution workflows, and real-time synchronization through Yjs CRDT.
 * Includes both inline comment indicators and comprehensive side-panel discussion views.
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { RenderMimeRegistry } from '@jupyterlab/rendermime';
import { ICellModel } from '@jupyterlab/cells';
import { showDialog } from '@jupyterlab/apputils';
import { INotebookTracker } from '@jupyterlab/notebook';
import { ITranslator } from '@jupyterlab/translation';
import { marked } from 'marked';

import { CommentStore } from 'packages/notebook/src/collab/comments';
import { IComment } from 'packages/notebook/src/tokens';
import { PermissionManager } from 'packages/notebook/src/collab/permissions';

/**
 * Interface for CommentPanel component props
 */
export interface ICommentPanelProps {
  commentStore: CommentStore;
  notebookTracker: INotebookTracker;
  currentCell?: ICellModel | null;
  translator: ITranslator;
  permissionManager: PermissionManager;
  renderMimeRegistry?: RenderMimeRegistry;
}

/**
 * Interface for CommentThread component props
 */
export interface ICommentThreadProps {
  thread: IComment[];
  commentStore: CommentStore;
  translator: ITranslator;
  permissionManager: PermissionManager;
  renderMimeRegistry?: RenderMimeRegistry;
  onResolve?: (commentId: string) => void;
  onReply?: (parentId: string, content: string) => void;
  onEdit?: (commentId: string, content: string) => void;
  onDelete?: (commentId: string) => void;
}

/**
 * Interface for CommentIndicator component props
 */
export interface ICommentIndicatorProps {
  cellId: string;
  commentStore: CommentStore;
  translator: ITranslator;
  onOpenPanel?: () => void;
  position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
}

/**
 * Comment filter modes for organizing discussions
 */
enum CommentFilterMode {
  ALL = 'all',
  UNRESOLVED = 'unresolved',
  MENTIONS = 'mentions',
  MY_COMMENTS = 'my_comments'
}

/**
 * Comment sort options for thread organization
 */
enum CommentSortMode {
  NEWEST = 'newest',
  OLDEST = 'oldest',
  MOST_REPLIES = 'most_replies',
  ACTIVITY = 'activity'
}

/**
 * Main CommentPanel component for threaded discussions
 */
export const CommentPanel: React.FC<ICommentPanelProps> = ({
  commentStore,
  notebookTracker,
  currentCell,
  translator,
  permissionManager,
  renderMimeRegistry
}) => {
  const trans = translator.load('notebook');

  // State management
  const [comments, setComments] = useState<IComment[]>([]);
  const [selectedThread, setSelectedThread] = useState<IComment | null>(null);
  const [replyText, setReplyText] = useState<string>('');
  const [filterMode, setFilterMode] = useState<CommentFilterMode>(CommentFilterMode.ALL);
  const [sortMode, setSortMode] = useState<CommentSortMode>(CommentSortMode.NEWEST);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [newCommentText, setNewCommentText] = useState<string>('');
  const [showNewCommentForm, setShowNewCommentForm] = useState<boolean>(false);
  const [notificationCount, setNotificationCount] = useState<number>(0);
  const [mentionsFilter, setMentionsFilter] = useState<string>('');

  // Refs for UI management
  const replyInputRef = useRef<HTMLTextAreaElement>(null);
  const newCommentInputRef = useRef<HTMLTextAreaElement>(null);

  // Load comments and set up real-time sync
  useEffect(() => {
    const loadComments = async () => {
      setLoading(true);
      setError(null);

      try {
        if (currentCell?.id) {
          const cellComments = await commentStore.getCommentsByCell(currentCell.id);
          setComments(cellComments);
        } else {
          // Load all comments if no specific cell selected
          const allComments = await commentStore.getCommentsByUser(''); // Get all
          setComments(allComments);
        }

        // Update notification count
        const count = commentStore.getNotificationCount();
        setNotificationCount(count);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load comments');
        console.error('Error loading comments:', err);
      } finally {
        setLoading(false);
      }
    };

    loadComments();

    // Subscribe to comment updates
    const unsubscribe = commentStore.subscribeToNotifications((notification) => {
      // Refresh comments on notifications
      loadComments();

      // Show notification toast
      if (notification.type === 'mention') {
        showDialog({
          title: trans.__('New Mention'),
          body: trans.__('You were mentioned in a comment'),
          buttons: [{ label: trans.__('OK') }]
        });
      }
    });

    return () => {
      unsubscribe();
    };
  }, [commentStore, currentCell, trans]);

  // Filter and sort comments
  const filteredAndSortedComments = useMemo(() => {
    let filtered = [...comments];

    // Apply filters
    switch (filterMode) {
      case CommentFilterMode.UNRESOLVED:
        filtered = filtered.filter(c => !c.isResolved);
        break;
      case CommentFilterMode.MENTIONS:
        // Filter by mentions if a user is specified
        if (mentionsFilter) {
          filtered = filtered.filter(c => c.mentions.includes(mentionsFilter));
        }
        break;
      case CommentFilterMode.MY_COMMENTS:
        // Would need current user context - placeholder implementation
        break;
      default:
        // ALL - no filtering
        break;
    }

    // Apply sorting
    switch (sortMode) {
      case CommentSortMode.OLDEST:
        filtered.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        break;
      case CommentSortMode.MOST_REPLIES:
        filtered.sort((a, b) => b.replies.length - a.replies.length);
        break;
      case CommentSortMode.ACTIVITY:
        // Sort by latest activity in thread
        filtered.sort((a, b) => {
          const aLatest = Math.max(a.timestamp.getTime(), ...a.replies.map(r => r.timestamp.getTime()));
          const bLatest = Math.max(b.timestamp.getTime(), ...b.replies.map(r => r.timestamp.getTime()));
          return bLatest - aLatest;
        });
        break;
      default:
        // NEWEST
        filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        break;
    }

    return filtered;
  }, [comments, filterMode, sortMode, mentionsFilter]);

  // Handle new comment creation
  const handleCreateComment = async () => {
    if (!newCommentText.trim() || !currentCell?.id) {
      return;
    }

    try {
      setLoading(true);

      // Extract @mentions from text
      const mentions = extractMentions(newCommentText);

      await commentStore.create(currentCell.id, newCommentText, undefined, mentions);

      setNewCommentText('');
      setShowNewCommentForm(false);

      // Refresh comments
      const updatedComments = await commentStore.getCommentsByCell(currentCell.id);
      setComments(updatedComments);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create comment');
      console.error('Error creating comment:', err);
    } finally {
      setLoading(false);
    }
  };

  // Handle comment reply
  const handleReply = async (parentId: string, content: string) => {
    if (!content.trim()) {
      return;
    }

    try {
      const mentions = extractMentions(content);
      await commentStore.addReply(parentId, content, mentions);

      // Refresh comments
      if (currentCell?.id) {
        const updatedComments = await commentStore.getCommentsByCell(currentCell.id);
        setComments(updatedComments);
      }

      setReplyText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add reply');
      console.error('Error adding reply:', err);
    }
  };

  // Handle comment resolution
  const handleResolve = async (commentId: string) => {
    try {
      await commentStore.resolveComment(commentId);

      // Refresh comments
      if (currentCell?.id) {
        const updatedComments = await commentStore.getCommentsByCell(currentCell.id);
        setComments(updatedComments);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve comment');
      console.error('Error resolving comment:', err);
    }
  };

  // Handle comment editing
  const handleEdit = async (commentId: string, content: string) => {
    try {
      await commentStore.update(commentId, content);

      // Refresh comments
      if (currentCell?.id) {
        const updatedComments = await commentStore.getCommentsByCell(currentCell.id);
        setComments(updatedComments);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to edit comment');
      console.error('Error editing comment:', err);
    }
  };

  // Handle comment deletion
  const handleDelete = async (commentId: string) => {
    const result = await showDialog({
      title: trans.__('Delete Comment'),
      body: trans.__('Are you sure you want to delete this comment and all its replies?'),
      buttons: [
        { label: trans.__('Cancel') },
        { label: trans.__('Delete'), className: 'jp-mod-warn' }
      ]
    });

    if (result.button.label === trans.__('Delete')) {
      try {
        await commentStore.delete(commentId);

        // Refresh comments
        if (currentCell?.id) {
          const updatedComments = await commentStore.getCommentsByCell(currentCell.id);
          setComments(updatedComments);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete comment');
        console.error('Error deleting comment:', err);
      }
    }
  };

  return (
    <div className="jp-CommentPanel">
      {/* Header */}
      <div className="jp-CommentPanel-header">
        <h3 className="jp-CommentPanel-title">
          {trans.__('Comments')}
          {notificationCount > 0 && (
            <span className="jp-CommentPanel-notificationBadge">
              {notificationCount}
            </span>
          )}
        </h3>

        {/* Controls */}
        <div className="jp-CommentPanel-controls">
          {/* Filter */}
          <select
            value={filterMode}
            onChange={(e) => setFilterMode(e.target.value as CommentFilterMode)}
            className="jp-CommentPanel-filter"
          >
            <option value={CommentFilterMode.ALL}>{trans.__('All')}</option>
            <option value={CommentFilterMode.UNRESOLVED}>{trans.__('Unresolved')}</option>
            <option value={CommentFilterMode.MENTIONS}>{trans.__('Mentions')}</option>
            <option value={CommentFilterMode.MY_COMMENTS}>{trans.__('My Comments')}</option>
          </select>

          {/* Sort */}
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as CommentSortMode)}
            className="jp-CommentPanel-sort"
          >
            <option value={CommentSortMode.NEWEST}>{trans.__('Newest')}</option>
            <option value={CommentSortMode.OLDEST}>{trans.__('Oldest')}</option>
            <option value={CommentSortMode.MOST_REPLIES}>{trans.__('Most Replies')}</option>
            <option value={CommentSortMode.ACTIVITY}>{trans.__('Recent Activity')}</option>
          </select>
        </div>

        {/* New comment button */}
        {currentCell && (
          <button
            onClick={() => setShowNewCommentForm(true)}
            className="jp-CommentPanel-newButton"
            disabled={loading}
          >
            {trans.__('Add Comment')}
          </button>
        )}
      </div>

      {/* Error display */}
      {error && (
        <div className="jp-CommentPanel-error">
          {error}
        </div>
      )}

      {/* New comment form */}
      {showNewCommentForm && currentCell && (
        <div className="jp-CommentPanel-newForm">
          <textarea
            ref={newCommentInputRef}
            value={newCommentText}
            onChange={(e) => setNewCommentText(e.target.value)}
            placeholder={trans.__('Write a comment... (supports markdown and @mentions)')}
            className="jp-CommentPanel-newInput"
            rows={3}
          />
          <div className="jp-CommentPanel-newActions">
            <button
              onClick={handleCreateComment}
              disabled={!newCommentText.trim() || loading}
              className="jp-CommentPanel-createButton"
            >
              {trans.__('Comment')}
            </button>
            <button
              onClick={() => {
                setShowNewCommentForm(false);
                setNewCommentText('');
              }}
              className="jp-CommentPanel-cancelButton"
            >
              {trans.__('Cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Loading indicator */}
      {loading && (
        <div className="jp-CommentPanel-loading">
          {trans.__('Loading...')}
        </div>
      )}

      {/* Comments list */}
      <div className="jp-CommentPanel-list">
        {filteredAndSortedComments.length === 0 && !loading ? (
          <div className="jp-CommentPanel-empty">
            {trans.__('No comments yet')}
          </div>
        ) : (
          filteredAndSortedComments.map((comment) => (
            <div key={comment.id} className="jp-CommentPanel-item">
              <CommentThread
                thread={[comment, ...comment.replies]}
                commentStore={commentStore}
                translator={translator}
                permissionManager={permissionManager}
                renderMimeRegistry={renderMimeRegistry}
                onResolve={handleResolve}
                onReply={handleReply}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
};

/**
 * CommentThread component for displaying threaded comment discussions
 */
export const CommentThread: React.FC<ICommentThreadProps> = ({
  thread,
  commentStore,
  translator,
  permissionManager,
  renderMimeRegistry,
  onResolve,
  onReply,
  onEdit,
  onDelete
}) => {
  const trans = translator.load('notebook');
  const [showReplyForm, setShowReplyForm] = useState<boolean>(false);
  const [replyText, setReplyText] = useState<string>('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState<string>('');
  const [canEdit, setCanEdit] = useState<boolean>(false);
  const [userRole, setUserRole] = useState<string>('viewer');

  const rootComment = thread[0];
  const replies = thread.slice(1);

  // Check permissions
  useEffect(() => {
    const checkPermissions = async () => {
      const canEditComments = await permissionManager.canEdit('current-user'); // Would need actual user ID
      const role = await permissionManager.getUserRole('current-user');
      setCanEdit(canEditComments);
      setUserRole(role);
    };

    checkPermissions();
  }, [permissionManager]);

  // Handle reply submission
  const handleSubmitReply = () => {
    if (replyText.trim() && onReply) {
      onReply(rootComment.id, replyText);
      setReplyText('');
      setShowReplyForm(false);
    }
  };

  // Handle edit submission
  const handleSubmitEdit = (commentId: string) => {
    if (editText.trim() && onEdit) {
      onEdit(commentId, editText);
      setEditingId(null);
      setEditText('');
    }
  };

  // Render comment content with markdown
  const renderCommentContent = (content: string) => {
    if (renderMimeRegistry) {
      try {
        const html = marked(content);
        return <div dangerouslySetInnerHTML={{ __html: html }} />;
      } catch (err) {
        console.error('Error rendering markdown:', err);
        return <div>{content}</div>;
      }
    }
    return <div>{content}</div>;
  };

  // Format timestamp
  const formatTimestamp = (timestamp: Date) => {
    const now = new Date();
    const diff = now.getTime() - timestamp.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return trans.__('Just now');
    if (minutes < 60) return trans.__('%1 minutes ago', minutes.toString());
    if (hours < 24) return trans.__('%1 hours ago', hours.toString());
    return trans.__('%1 days ago', days.toString());
  };

  return (
    <div className="jp-CommentThread">
      {/* Root comment */}
      <div className={`jp-CommentCard ${rootComment.isResolved ? 'jp-mod-resolved' : ''}`}>
        <div className="jp-CommentCard-header">
          <div className="jp-CommentCard-author">
            <img
              src={rootComment.author.avatar || '/default-avatar.png'}
              alt={rootComment.author.displayName}
              className="jp-CommentCard-avatar"
            />
            <span className="jp-CommentCard-authorName">
              {rootComment.author.displayName}
            </span>
          </div>
          <div className="jp-CommentCard-meta">
            <span className="jp-CommentCard-timestamp">
              {formatTimestamp(rootComment.timestamp)}
            </span>
            {rootComment.isResolved && (
              <span className="jp-CommentCard-resolvedBadge">
                {trans.__('Resolved')}
              </span>
            )}
            {replies.length > 0 && (
              <span className="jp-CommentCard-replyCount">
                {trans.__('%1 replies', replies.length.toString())}
              </span>
            )}
          </div>
        </div>

        {/* Comment content */}
        <div className="jp-CommentCard-content">
          {editingId === rootComment.id ? (
            <div className="jp-CommentCard-editForm">
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                className="jp-CommentCard-editInput"
                rows={3}
              />
              <div className="jp-CommentCard-editActions">
                <button
                  onClick={() => handleSubmitEdit(rootComment.id)}
                  className="jp-CommentCard-saveButton"
                >
                  {trans.__('Save')}
                </button>
                <button
                  onClick={() => {
                    setEditingId(null);
                    setEditText('');
                  }}
                  className="jp-CommentCard-cancelButton"
                >
                  {trans.__('Cancel')}
                </button>
              </div>
            </div>
          ) : (
            <div className="jp-CommentMarkdown">
              {renderCommentContent(rootComment.content)}
            </div>
          )}

          {/* Mentions */}
          {rootComment.mentions.length > 0 && (
            <div className="jp-CommentCard-mentions">
              <span className="jp-CommentCard-mentionsLabel">
                {trans.__('Mentions:')}
              </span>
              {rootComment.mentions.map((mention, index) => (
                <span key={index} className="jp-CommentCard-mention">
                  @{mention}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="jp-CommentCard-actions">
          {canEdit && (
            <>
              <button
                onClick={() => setShowReplyForm(true)}
                className="jp-CommentCard-replyButton"
              >
                {trans.__('Reply')}
              </button>

              {!rootComment.isResolved && onResolve && (
                <button
                  onClick={() => onResolve(rootComment.id)}
                  className="jp-CommentCard-resolveButton"
                >
                  {trans.__('Resolve')}
                </button>
              )}

              <button
                onClick={() => {
                  setEditingId(rootComment.id);
                  setEditText(rootComment.content);
                }}
                className="jp-CommentCard-editButton"
              >
                {trans.__('Edit')}
              </button>

              {onDelete && (
                <button
                  onClick={() => onDelete(rootComment.id)}
                  className="jp-CommentCard-deleteButton jp-mod-warn"
                >
                  {trans.__('Delete')}
                </button>
              )}
            </>
          )}
        </div>

        {/* Reply form */}
        {showReplyForm && (
          <div className="jp-CommentCard-replyForm">
            <textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder={trans.__('Write a reply... (supports markdown and @mentions)')}
              className="jp-CommentCard-replyInput"
              rows={2}
            />
            <div className="jp-CommentCard-replyActions">
              <button
                onClick={handleSubmitReply}
                disabled={!replyText.trim()}
                className="jp-CommentCard-submitReplyButton"
              >
                {trans.__('Reply')}
              </button>
              <button
                onClick={() => {
                  setShowReplyForm(false);
                  setReplyText('');
                }}
                className="jp-CommentCard-cancelReplyButton"
              >
                {trans.__('Cancel')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Replies */}
      {replies.length > 0 && (
        <div className="jp-CommentThread-replies">
          {replies.map((reply) => (
            <div key={reply.id} className="jp-CommentReply">
              <div className="jp-CommentCard">
                <div className="jp-CommentCard-header">
                  <div className="jp-CommentCard-author">
                    <img
                      src={reply.author.avatar || '/default-avatar.png'}
                      alt={reply.author.displayName}
                      className="jp-CommentCard-avatar jp-mod-small"
                    />
                    <span className="jp-CommentCard-authorName">
                      {reply.author.displayName}
                    </span>
                  </div>
                  <div className="jp-CommentCard-meta">
                    <span className="jp-CommentCard-timestamp">
                      {formatTimestamp(reply.timestamp)}
                    </span>
                  </div>
                </div>

                <div className="jp-CommentCard-content">
                  {editingId === reply.id ? (
                    <div className="jp-CommentCard-editForm">
                      <textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        className="jp-CommentCard-editInput"
                        rows={2}
                      />
                      <div className="jp-CommentCard-editActions">
                        <button
                          onClick={() => handleSubmitEdit(reply.id)}
                          className="jp-CommentCard-saveButton"
                        >
                          {trans.__('Save')}
                        </button>
                        <button
                          onClick={() => {
                            setEditingId(null);
                            setEditText('');
                          }}
                          className="jp-CommentCard-cancelButton"
                        >
                          {trans.__('Cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="jp-CommentMarkdown">
                      {renderCommentContent(reply.content)}
                    </div>
                  )}

                  {reply.mentions.length > 0 && (
                    <div className="jp-CommentCard-mentions">
                      <span className="jp-CommentCard-mentionsLabel">
                        {trans.__('Mentions:')}
                      </span>
                      {reply.mentions.map((mention, index) => (
                        <span key={index} className="jp-CommentCard-mention">
                          @{mention}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {canEdit && (
                  <div className="jp-CommentCard-actions">
                    <button
                      onClick={() => {
                        setEditingId(reply.id);
                        setEditText(reply.content);
                      }}
                      className="jp-CommentCard-editButton"
                    >
                      {trans.__('Edit')}
                    </button>
                    {onDelete && (
                      <button
                        onClick={() => onDelete(reply.id)}
                        className="jp-CommentCard-deleteButton jp-mod-warn"
                      >
                        {trans.__('Delete')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * CommentIndicator component for displaying comment markers on cells
 */
export const CommentIndicator: React.FC<ICommentIndicatorProps> = ({
  cellId,
  commentStore,
  translator,
  onOpenPanel,
  position = 'top-right'
}) => {
  const trans = translator.load('notebook');
  const [commentCount, setCommentCount] = useState<number>(0);
  const [hasUnresolved, setHasUnresolved] = useState<boolean>(false);
  const [latestComment, setLatestComment] = useState<IComment | null>(null);
  const [showPreview, setShowPreview] = useState<boolean>(false);

  // Load comment data for this cell
  useEffect(() => {
    const loadCellComments = async () => {
      try {
        const comments = await commentStore.getCommentsByCell(cellId);
        setCommentCount(comments.length);

        const unresolved = comments.filter(c => !c.isResolved);
        setHasUnresolved(unresolved.length > 0);

        if (comments.length > 0) {
          const latest = comments.reduce((latest, comment) =>
            comment.timestamp > latest.timestamp ? comment : latest
          );
          setLatestComment(latest);
        }
      } catch (err) {
        console.error('Error loading cell comments:', err);
      }
    };

    loadCellComments();

    // Subscribe to comment updates for this cell
    const unsubscribe = commentStore.subscribeToNotifications((notification) => {
      if (notification.comment.cellId === cellId) {
        loadCellComments();
      }
    });

    return () => {
      unsubscribe();
    };
  }, [cellId, commentStore]);

  // Don't render if no comments
  if (commentCount === 0) {
    return null;
  }

  const handleClick = () => {
    if (onOpenPanel) {
      onOpenPanel();
    }
  };

  const getPreviewText = () => {
    if (!latestComment) return '';
    const preview = latestComment.content.length > 50
      ? `${latestComment.content.substring(0, 50)}...`
      : latestComment.content;
    return `${latestComment.author.displayName}: ${preview}`;
  };

  return (
    <div
      className={`jp-CommentIndicator jp-mod-${position} ${hasUnresolved ? 'jp-mod-unresolved' : ''}`}
      onClick={handleClick}
      onMouseEnter={() => setShowPreview(true)}
      onMouseLeave={() => setShowPreview(false)}
      title={trans.__('Comments (%1)', commentCount.toString())}
    >
      <div className="jp-CommentIndicator-icon">
        <svg width="16" height="16" viewBox="0 0 16 16" className="jp-CommentIndicator-svg">
          <path d="M2 2h12a1 1 0 011 1v7a1 1 0 01-1 1H8l-3 3v-3H2a1 1 0 01-1-1V3a1 1 0 011-1z"
                fill="currentColor"
                stroke="currentColor"
                strokeWidth="1"
          />
        </svg>
      </div>

      <div className="jp-CommentIndicator-badge">
        {commentCount}
      </div>

      {hasUnresolved && (
        <div className="jp-CommentIndicator-unresolvedDot"
             title={trans.__('Has unresolved comments')} />
      )}

      {/* Preview tooltip */}
      {showPreview && latestComment && (
        <div className="jp-CommentIndicator-preview">
          <div className="jp-CommentIndicator-previewHeader">
            {trans.__('Latest comment')}
          </div>
          <div className="jp-CommentIndicator-previewContent">
            {getPreviewText()}
          </div>
          <div className="jp-CommentIndicator-previewFooter">
            {formatRelativeTime(latestComment.timestamp)}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * CommentSystemComponent for creating ReactWidgets
 */
export const CommentSystemComponent = {
  /**
   * Create a new CommentPanel widget
   */
  create: (props: ICommentPanelProps): ReactWidget => {
    return ReactWidget.create(
      <CommentPanel {...props} />
    );
  }
};

/**
 * Default export containing all comment system components
 */
const CommentSystem = {
  CommentPanel,
  CommentThread,
  CommentIndicator,
  CommentSystemComponent
};

export default CommentSystem;

// Helper functions

/**
 * Extract @mentions from comment text
 */
function extractMentions(text: string): string[] {
  const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
  const mentions: string[] = [];
  let match;

  while ((match = mentionRegex.exec(text)) !== null) {
    const mention = match[1];
    if (!mentions.includes(mention)) {
      mentions.push(mention);
    }
  }

  return mentions;
}

/**
 * Format timestamp as relative time
 */
function formatRelativeTime(timestamp: Date): string {
  const now = new Date();
  const diff = now.getTime() - timestamp.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}
