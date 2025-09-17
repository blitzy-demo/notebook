/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * Collaborative commenting and review system component enabling threaded discussions on notebook cells.
 * Supports markdown formatting, @-mentions, comment resolution workflows, and real-time synchronization
 * through Yjs. Provides both inline comment indicators and side-panel discussion views.
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { RenderMimeRegistry } from '@jupyterlab/rendermime';
import { Cell } from '@jupyterlab/cells';
import { INotebookTracker } from '@jupyterlab/notebook';
import { ITranslator } from '@jupyterlab/translation';

import { CommentStatus } from '../../../notebook/src/collab/comments';
import { PermissionManager } from '../../../notebook/src/collab/permissions';
import { ICommentStore } from '../../../notebook/src/tokens';

/**
 * Props interface for CommentPanel component
 */
export interface ICommentPanelProps {
  /**
   * Comment store service for managing comments
   */
  commentStore: ICommentStore;

  /**
   * Notebook tracker for accessing active notebook
   */
  notebookTracker: INotebookTracker;

  /**
   * Currently selected cell ID
   */
  currentCell?: string;

  /**
   * Translation service for internationalization
   */
  translator: ITranslator;

  /**
   * Permission manager for access control
   */
  permissionManager: PermissionManager;

  /**
   * Render MIME registry for markdown rendering
   */
  rendermime: RenderMimeRegistry;

  /**
   * Current user ID
   */
  userId: string;

  /**
   * Whether panel is visible
   */
  visible?: boolean;

  /**
   * Callback when panel visibility changes
   */
  onVisibilityChange?: (visible: boolean) => void;
}

/**
 * Props interface for CommentThread component
 */
export interface ICommentThreadProps {
  /**
   * Root comment of the thread
   */
  rootComment: any;

  /**
   * All comments in the thread
   */
  comments: any[];

  /**
   * Comment store for operations
   */
  commentStore: ICommentStore;

  /**
   * Permission manager for access control
   */
  permissionManager: PermissionManager;

  /**
   * Render MIME registry for markdown rendering
   */
  rendermime: RenderMimeRegistry;

  /**
   * Current user ID
   */
  userId: string;

  /**
   * Translation service
   */
  translator: ITranslator;

  /**
   * Whether thread is expanded
   */
  expanded?: boolean;

  /**
   * Callback when thread expansion changes
   */
  onExpandedChange?: (expanded: boolean) => void;

  /**
   * Callback when comment is resolved
   */
  onResolved?: (commentId: string) => void;
}

/**
 * Props interface for CommentIndicator component
 */
export interface ICommentIndicatorProps {
  /**
   * Cell ID this indicator is attached to
   */
  cellId: string;

  /**
   * Number of comments on this cell
   */
  commentCount: number;

  /**
   * Whether there are unresolved comments
   */
  hasUnresolved: boolean;

  /**
   * Cell widget reference
   */
  cell: Cell;

  /**
   * Comment store for operations
   */
  commentStore: ICommentStore;

  /**
   * Translation service
   */
  translator: ITranslator;

  /**
   * Callback when indicator is clicked
   */
  onClick?: (cellId: string) => void;

  /**
   * Whether to show preview on hover
   */
  showPreview?: boolean;
}

/**
 * Main CommentPanel React component for collaborative discussions
 */
export function CommentPanel(props: ICommentPanelProps): JSX.Element {
  const {
    commentStore,
    currentCell,
    translator,
    permissionManager,
    rendermime,
    userId,
    visible = true
  } = props;

  const trans = translator.load('notebook');

  // Component state
  const [comments, setComments] = useState<any[]>([]);
  const [selectedThread, setSelectedThread] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<'all' | 'unresolved' | 'mentions'>('all');
  const [sortMode, setSortMode] = useState<'newest' | 'oldest' | 'most_replies'>('newest');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newCommentText, setNewCommentText] = useState('');
  const [canEdit, setCanEdit] = useState(false);

  // Remove unused replyInputRef

  // Check permissions
  useEffect(() => {
    const checkPermissions = async () => {
      try {
        const hasEditPermission = await permissionManager.canEdit(userId);
        setCanEdit(hasEditPermission);
      } catch (error) {
        console.error('Error checking permissions:', error);
        setCanEdit(false);
      }
    };

    checkPermissions();
  }, [permissionManager, userId]);

  // Fetch and subscribe to comments
  useEffect(() => {
    const fetchComments = async () => {
      if (!currentCell || !commentStore) {
        setComments([]);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const cellComments = await commentStore.getCommentsByCell(currentCell);
        setComments(cellComments || []);
      } catch (err) {
        console.error('Error fetching comments:', err);
        setError('Failed to load comments');
        setComments([]);
      } finally {
        setLoading(false);
      }
    };

    fetchComments();

    // Subscribe to comment changes
    if (commentStore && commentStore.subscribeToNotifications) {
      const unsubscribe = commentStore.subscribeToNotifications((comment: any, action: string) => {
        if (comment?.cellId === currentCell) {
          // Refresh comments when there are updates
          fetchComments();
        }
      });

      return unsubscribe;
    }
  }, [currentCell, commentStore]);

  // Filter and sort comments
  const processedComments = useMemo(() => {
    let filtered = [...comments];

    // Apply filters
    switch (filterMode) {
      case 'unresolved':
        filtered = filtered.filter(comment => !comment.isResolved);
        break;
      case 'mentions':
        filtered = filtered.filter(comment =>
          comment.mentions && comment.mentions.includes(userId)
        );
        break;
      case 'all':
      default:
        break;
    }

    // Apply sorting
    switch (sortMode) {
      case 'oldest':
        filtered.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        break;
      case 'most_replies':
        filtered.sort((a, b) => (b.replies?.length || 0) - (a.replies?.length || 0));
        break;
      case 'newest':
      default:
        filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        break;
    }

    return filtered;
  }, [comments, filterMode, sortMode, userId]);

  // Handle new comment creation
  const handleAddComment = async () => {
    if (!newCommentText.trim() || !canEdit || !currentCell) {
      return;
    }

    try {
      setLoading(true);
      await commentStore.create(currentCell, newCommentText);
      setNewCommentText('');
    } catch (error) {
      console.error('Error adding comment:', error);
      setError('Failed to add comment');
    } finally {
      setLoading(false);
    }
  };

  // Remove unused handleReply - functionality is in CommentThread component

  // Handle comment resolution
  const handleResolveComment = async (commentId: string) => {
    if (!canEdit) {
      return;
    }

    try {
      await commentStore.resolveComment(commentId);
    } catch (error) {
      console.error('Error resolving comment:', error);
      setError('Failed to resolve comment');
    }
  };

  // Render comment card
  const renderCommentCard = (comment: any) => {
    const isSelected = selectedThread === comment.id;
    const hasReplies = comment.replies && comment.replies.length > 0;
    const isResolved = comment.isResolved || comment.status === CommentStatus.RESOLVED;

    return (
      <div
        key={comment.id}
        className={`jp-CommentCard ${isSelected ? 'jp-mod-selected' : ''} ${isResolved ? 'jp-mod-resolved' : ''}`}
        onClick={() => setSelectedThread(isSelected ? null : comment.id)}
      >
        <div className="jp-CommentCard-header">
          <div className="jp-CommentCard-author">
            <img
              src={comment.author?.avatar || '/default-avatar.png'}
              alt={comment.author?.displayName || 'User'}
              className="jp-CommentCard-avatar"
            />
            <span className="jp-CommentCard-name">
              {comment.author?.displayName || 'Anonymous'}
            </span>
            <span className="jp-CommentCard-timestamp">
              {new Date(comment.timestamp).toLocaleString()}
            </span>
          </div>
          <div className="jp-CommentCard-badges">
            {hasReplies && (
              <span className="jp-CommentCard-badge jp-CommentCard-replyCount">
                {comment.replies.length} {comment.replies.length === 1 ? 'reply' : 'replies'}
              </span>
            )}
            {isResolved && (
              <span className="jp-CommentCard-badge jp-CommentCard-resolved">
                {trans.__('Resolved')}
              </span>
            )}
          </div>
        </div>
        <div className="jp-CommentCard-content">
          <div className="jp-CommentMarkdown">
            {comment.content}
          </div>
        </div>
        {canEdit && !isResolved && (
          <div className="jp-CommentCard-actions">
            <button
              className="jp-Button jp-CommentCard-resolve"
              onClick={(e) => {
                e.stopPropagation();
                handleResolveComment(comment.id);
              }}
            >
              {trans.__('Resolve')}
            </button>
          </div>
        )}
      </div>
    );
  };

  if (!visible) {
    return <div />;
  }

  return (
    <div className="jp-CommentPanel">
      <div className="jp-CommentPanel-header">
        <h3 className="jp-CommentPanel-title">
          {trans.__('Comments')}
          {currentCell && (
            <span className="jp-CommentPanel-cellInfo">
              ({comments.length} {comments.length === 1 ? 'comment' : 'comments'})
            </span>
          )}
        </h3>

        {/* Filter and sort controls */}
        <div className="jp-CommentPanel-controls">
          <select
            value={filterMode}
            onChange={(e) => setFilterMode(e.target.value as any)}
            className="jp-CommentPanel-filter"
          >
            <option value="all">{trans.__('All Comments')}</option>
            <option value="unresolved">{trans.__('Unresolved')}</option>
            <option value="mentions">{trans.__('Mentions')}</option>
          </select>

          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as any)}
            className="jp-CommentPanel-sort"
          >
            <option value="newest">{trans.__('Newest First')}</option>
            <option value="oldest">{trans.__('Oldest First')}</option>
            <option value="most_replies">{trans.__('Most Replies')}</option>
          </select>
        </div>
      </div>

      <div className="jp-CommentPanel-body">
        {loading && (
          <div className="jp-CommentPanel-loading">
            {trans.__('Loading comments...')}
          </div>
        )}

        {error && (
          <div className="jp-CommentPanel-error">
            {error}
          </div>
        )}

        {!loading && !error && processedComments.length === 0 && (
          <div className="jp-CommentPanel-empty">
            {currentCell
              ? trans.__('No comments on this cell yet.')
              : trans.__('Select a cell to view comments.')
            }
          </div>
        )}

        {!loading && processedComments.length > 0 && (
          <div className="jp-CommentPanel-list">
            {processedComments.map(comment => renderCommentCard(comment))}
          </div>
        )}

        {/* Selected thread detail */}
        {selectedThread && (
          <CommentThread
            rootComment={comments.find(c => c.id === selectedThread)}
            comments={comments.filter(c => c.id === selectedThread || c.parentId === selectedThread)}
            commentStore={commentStore}
            permissionManager={permissionManager}
            rendermime={rendermime}
            userId={userId}
            translator={translator}
            onResolved={handleResolveComment}
          />
        )}
      </div>

      {/* New comment input */}
      {canEdit && currentCell && (
        <div className="jp-CommentPanel-footer">
          <div className="jp-CommentPanel-input">
            <textarea
              value={newCommentText}
              onChange={(e) => setNewCommentText(e.target.value)}
              placeholder={trans.__('Add a comment...')}
              className="jp-CommentPanel-textarea"
              rows={3}
            />
            <div className="jp-CommentPanel-inputActions">
              <button
                onClick={handleAddComment}
                disabled={!newCommentText.trim() || loading}
                className="jp-Button jp-mod-styled jp-mod-accept"
              >
                {trans.__('Comment')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * CommentThread component displaying full comment thread with parent and replies
 */
export function CommentThread(props: ICommentThreadProps): JSX.Element {
  const {
    rootComment,
    comments,
    commentStore,
    permissionManager,
    userId,
    translator,
    expanded = true,
    onExpandedChange,
    onResolved
  } = props;

  const trans = translator.load('notebook');

  // Component state
  const [replyText, setReplyText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showReplyInput, setShowReplyInput] = useState(false);

  const replyInputRef = useRef<HTMLTextAreaElement>(null);

  // Check permissions
  useEffect(() => {
    const checkPermissions = async () => {
      try {
        const hasEditPermission = await permissionManager.canEdit(userId);
        setCanEdit(hasEditPermission);
      } catch (error) {
        console.error('Error checking permissions:', error);
        setCanEdit(false);
      }
    };

    checkPermissions();
  }, [permissionManager, userId]);

  // Focus reply input when shown
  useEffect(() => {
    if (showReplyInput && replyInputRef.current) {
      replyInputRef.current.focus();
    }
  }, [showReplyInput]);

  // Handle reply submission
  const handleReply = async () => {
    if (!replyText.trim() || !canEdit || !rootComment) {
      return;
    }

    try {
      setLoading(true);
      await commentStore.addReply(rootComment.id, replyText);
      setReplyText('');
      setShowReplyInput(false);
    } catch (error) {
      console.error('Error adding reply:', error);
    } finally {
      setLoading(false);
    }
  };

  // Handle comment editing
  const handleEdit = async (commentId: string) => {
    if (!editText.trim() || !canEdit) {
      return;
    }

    try {
      setLoading(true);
      await commentStore.update(commentId, editText);
      setEditingId(null);
      setEditText('');
    } catch (error) {
      console.error('Error editing comment:', error);
    } finally {
      setLoading(false);
    }
  };

  // Handle comment deletion
  const handleDelete = async (commentId: string) => {
    if (!canEdit || !confirm(trans.__('Are you sure you want to delete this comment?'))) {
      return;
    }

    try {
      setLoading(true);
      await commentStore.delete(commentId);
    } catch (error) {
      console.error('Error deleting comment:', error);
    } finally {
      setLoading(false);
    }
  };

  // Handle comment resolution
  const handleResolve = async (commentId: string) => {
    if (!canEdit) {
      return;
    }

    try {
      await commentStore.resolveComment(commentId);
      if (onResolved) {
        onResolved(commentId);
      }
    } catch (error) {
      console.error('Error resolving comment:', error);
    }
  };

  // Start editing a comment
  const startEdit = (comment: any) => {
    setEditingId(comment.id);
    setEditText(comment.content);
  };

  // Cancel editing
  const cancelEdit = () => {
    setEditingId(null);
    setEditText('');
  };

  // Parse and render @mentions
  const renderContentWithMentions = (content: string) => {
    const mentionRegex = /@(\w+)/g;
    const parts = content.split(mentionRegex);

    return parts.map((part, index) => {
      if (index % 2 === 1) {
        // This is a mention
        return (
          <span key={index} className="jp-CommentMention">
            @{part}
          </span>
        );
      }
      // Regular content - render as text for now
      return (
        <span key={index} className="jp-CommentMarkdown">
          {part}
        </span>
      );
    });
  };

  // Render individual comment
  const renderComment = (comment: any, isReply = false) => {
    const isEditing = editingId === comment.id;
    const isResolved = comment.isResolved || comment.status === CommentStatus.RESOLVED;
    const isOwnComment = comment.author?.userId === userId;

    return (
      <div
        key={comment.id}
        className={`jp-CommentThread-comment ${isReply ? 'jp-CommentReply' : ''} ${isResolved ? 'jp-mod-resolved' : ''}`}
      >
        <div className="jp-CommentThread-header">
          <div className="jp-CommentThread-author">
            <img
              src={comment.author?.avatar || '/default-avatar.png'}
              alt={comment.author?.displayName || 'User'}
              className="jp-CommentThread-avatar"
            />
            <span className="jp-CommentThread-name">
              {comment.author?.displayName || 'Anonymous'}
            </span>
            <span className="jp-CommentThread-timestamp">
              {new Date(comment.timestamp).toLocaleString()}
            </span>
            {isResolved && (
              <span className="jp-CommentThread-resolved">
                {trans.__('Resolved')}
              </span>
            )}
          </div>

          {canEdit && (isOwnComment || comment.author?.userId === userId) && (
            <div className="jp-CommentThread-actions">
              {!isEditing && (
                <>
                  <button
                    className="jp-Button jp-CommentThread-edit"
                    onClick={() => startEdit(comment)}
                    title={trans.__('Edit comment')}
                  >
                    ✏️
                  </button>
                  <button
                    className="jp-Button jp-CommentThread-delete"
                    onClick={() => handleDelete(comment.id)}
                    title={trans.__('Delete comment')}
                  >
                    🗑️
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="jp-CommentThread-content">
          {isEditing ? (
            <div className="jp-CommentThread-edit">
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                className="jp-CommentThread-editInput"
                rows={3}
              />
              <div className="jp-CommentThread-editActions">
                <button
                  onClick={() => handleEdit(comment.id)}
                  disabled={!editText.trim() || loading}
                  className="jp-Button jp-mod-styled jp-mod-accept"
                >
                  {trans.__('Save')}
                </button>
                <button
                  onClick={cancelEdit}
                  className="jp-Button jp-mod-styled"
                >
                  {trans.__('Cancel')}
                </button>
              </div>
            </div>
          ) : (
            <div className="jp-CommentThread-text">
              {renderContentWithMentions(comment.content)}
            </div>
          )}
        </div>

        {!isReply && canEdit && !isResolved && (
          <div className="jp-CommentThread-footer">
            <button
              onClick={() => setShowReplyInput(!showReplyInput)}
              className="jp-Button jp-CommentThread-replyButton"
            >
              {trans.__('Reply')}
            </button>
            <button
              onClick={() => handleResolve(comment.id)}
              className="jp-Button jp-CommentThread-resolveButton"
            >
              {trans.__('Resolve')}
            </button>
          </div>
        )}
      </div>
    );
  };

  if (!rootComment || !expanded) {
    return <div />;
  }

  // Sort replies by timestamp
  const replies = comments
    .filter(c => c.parentId === rootComment.id)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return (
    <div className="jp-CommentThread">
      <div className="jp-CommentThread-header">
        <button
          onClick={() => onExpandedChange && onExpandedChange(!expanded)}
          className="jp-Button jp-CommentThread-toggleButton"
        >
          {expanded ? '▼' : '▶'} {trans.__('Thread')}
        </button>
      </div>

      <div className="jp-CommentThread-body">
        {/* Root comment */}
        {renderComment(rootComment, false)}

        {/* Replies */}
        {replies.length > 0 && (
          <div className="jp-CommentThread-replies">
            {replies.map(reply => renderComment(reply, true))}
          </div>
        )}

        {/* Reply input */}
        {showReplyInput && canEdit && (
          <div className="jp-CommentThread-replyInput">
            <textarea
              ref={replyInputRef}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder={trans.__('Add a reply...')}
              className="jp-CommentThread-textarea"
              rows={3}
            />
            <div className="jp-CommentThread-replyActions">
              <button
                onClick={handleReply}
                disabled={!replyText.trim() || loading}
                className="jp-Button jp-mod-styled jp-mod-accept"
              >
                {trans.__('Reply')}
              </button>
              <button
                onClick={() => setShowReplyInput(false)}
                className="jp-Button jp-mod-styled"
              >
                {trans.__('Cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * CommentIndicator component - small icon overlay on cells with comments
 */
export function CommentIndicator(props: ICommentIndicatorProps): JSX.Element {
  const {
    cellId,
    commentCount,
    hasUnresolved,
    commentStore,
    translator,
    onClick,
    showPreview = true
  } = props;

  const trans = translator.load('notebook');

  // Component state
  const [showTooltip, setShowTooltip] = useState(false);
  const [previewComments, setPreviewComments] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const tooltipRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);

  // Load preview comments on hover
  useEffect(() => {
    if (showTooltip && showPreview && commentStore) {
      const loadPreview = async () => {
        try {
          setLoading(true);
          const comments = await commentStore.getCommentsByCell(cellId);
          // Get latest 3 comments for preview
          const sortedComments = (comments || [])
            .sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
            .slice(0, 3);
          setPreviewComments(sortedComments);
        } catch (error) {
          console.error('Error loading preview comments:', error);
          setPreviewComments([]);
        } finally {
          setLoading(false);
        }
      };

      loadPreview();
    }
  }, [showTooltip, showPreview, commentStore, cellId]);

  // Handle click
  const handleClick = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    if (onClick) {
      onClick(cellId);
    }
  };

  // Handle mouse enter
  const handleMouseEnter = () => {
    if (showPreview) {
      setShowTooltip(true);
    }
  };

  // Handle mouse leave
  const handleMouseLeave = () => {
    setShowTooltip(false);
  };

  // Position tooltip
  const positionTooltip = () => {
    if (!tooltipRef.current || !indicatorRef.current) {
      return {};
    }

    const indicatorRect = indicatorRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();

    // Position to the right of indicator, or left if not enough space
    const spaceToRight = window.innerWidth - indicatorRect.right;
    const spaceToLeft = indicatorRect.left;

    let left = indicatorRect.right + 8;
    if (spaceToRight < tooltipRect.width + 16 && spaceToLeft > tooltipRect.width + 16) {
      left = indicatorRect.left - tooltipRect.width - 8;
    }

    return {
      position: 'fixed' as const,
      top: Math.max(8, indicatorRect.top - tooltipRect.height / 2 + indicatorRect.height / 2),
      left: Math.max(8, Math.min(left, window.innerWidth - tooltipRect.width - 8)),
      zIndex: 1000
    };
  };

  // Render preview tooltip
  const renderPreviewTooltip = () => {
    if (!showTooltip || !showPreview) {
      return null;
    }

    return (
      <div
        ref={tooltipRef}
        className="jp-CommentIndicator-tooltip"
        style={positionTooltip()}
      >
        <div className="jp-CommentIndicator-tooltipHeader">
          <strong>
            {commentCount} {commentCount === 1 ? trans.__('Comment') : trans.__('Comments')}
          </strong>
          {hasUnresolved && (
            <span className="jp-CommentIndicator-unresolvedBadge">
              {trans.__('Unresolved')}
            </span>
          )}
        </div>

        {loading ? (
          <div className="jp-CommentIndicator-loading">
            {trans.__('Loading...')}
          </div>
        ) : previewComments.length > 0 ? (
          <div className="jp-CommentIndicator-preview">
            {previewComments.map(comment => (
              <div key={comment.id} className="jp-CommentIndicator-previewComment">
                <div className="jp-CommentIndicator-previewHeader">
                  <span className="jp-CommentIndicator-previewAuthor">
                    {comment.author?.displayName || 'Anonymous'}
                  </span>
                  <span className="jp-CommentIndicator-previewTime">
                    {new Date(comment.timestamp).toLocaleString()}
                  </span>
                </div>
                <div className="jp-CommentIndicator-previewContent">
                  {comment.content.length > 100
                    ? comment.content.substring(0, 100) + '...'
                    : comment.content
                  }
                </div>
              </div>
            ))}
            {commentCount > 3 && (
              <div className="jp-CommentIndicator-moreComments">
                {trans.__('And %1 more...').replace('%1', String(commentCount - 3))}
              </div>
            )}
          </div>
        ) : (
          <div className="jp-CommentIndicator-noPreview">
            {trans.__('No preview available')}
          </div>
        )}

        <div className="jp-CommentIndicator-tooltipFooter">
          <small>{trans.__('Click to view all comments')}</small>
        </div>
      </div>
    );
  };

  if (commentCount === 0) {
    return <div />;
  }

  return (
    <>
      <div
        ref={indicatorRef}
        className={`jp-CommentIndicator ${hasUnresolved ? 'jp-mod-unresolved' : ''}`}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        title={`${commentCount} ${commentCount === 1 ? 'comment' : 'comments'}${hasUnresolved ? ' (unresolved)' : ''}`}
      >
        <div className="jp-CommentIndicator-icon">
          💬
        </div>

        {commentCount > 0 && (
          <div className="jp-CommentIndicator-badge">
            {commentCount > 99 ? '99+' : commentCount}
          </div>
        )}

        {hasUnresolved && (
          <div className="jp-CommentIndicator-unresolvedDot">
            •
          </div>
        )}
      </div>

      {/* Render tooltip in portal-like manner */}
      {showTooltip && showPreview && (
        <div className="jp-CommentIndicator-tooltipContainer">
          {renderPreviewTooltip()}
        </div>
      )}
    </>
  );
}

/**
 * Comment system management class providing factory methods and coordination
 * between comment panel, thread, and indicator components
 */
export class commentSystem {
  private _commentStore: ICommentStore;
  private _permissionManager: PermissionManager;
  private _notebookTracker: INotebookTracker;
  private _translator: ITranslator;
  private _rendermime: RenderMimeRegistry;
  private _currentUserId: string;
  private _panelWidget: ReactWidget | null = null;
  private _indicators: Map<string, ReactWidget> = new Map();

  constructor(
    commentStore: ICommentStore,
    permissionManager: PermissionManager,
    notebookTracker: INotebookTracker,
    translator: ITranslator,
    rendermime: RenderMimeRegistry,
    userId: string
  ) {
    this._commentStore = commentStore;
    this._permissionManager = permissionManager;
    this._notebookTracker = notebookTracker;
    this._translator = translator;
    this._rendermime = rendermime;
    this._currentUserId = userId;
  }

  /**
   * Create a comment panel widget for integration into the application shell
   */
  create(): ReactWidget {
    if (this._panelWidget) {
      return this._panelWidget;
    }

    const currentNotebook = this._notebookTracker.currentWidget;
    const currentCell = currentNotebook?.content.activeCellIndex !== -1
      ? currentNotebook?.content.activeCell?.model.id
      : undefined;

    this._panelWidget = ReactWidget.create(
      <CommentPanel
        commentStore={this._commentStore}
        notebookTracker={this._notebookTracker}
        currentCell={currentCell}
        translator={this._translator}
        permissionManager={this._permissionManager}
        rendermime={this._rendermime}
        userId={this._currentUserId}
        visible={true}
      />
    );

    this._panelWidget.id = 'comment-panel';
    this._panelWidget.title.label = this._translator.load('notebook').__('Comments');
    this._panelWidget.title.closable = true;

    return this._panelWidget;
  }

  /**
   * Show comments panel for a specific cell
   */
  async showComments(cellId?: string): Promise<void> {
    if (!this._panelWidget) {
      this.create();
    }

    if (this._panelWidget && cellId) {
      // Update the panel to show comments for the specified cell
      const props = {
        commentStore: this._commentStore,
        notebookTracker: this._notebookTracker,
        currentCell: cellId,
        translator: this._translator,
        permissionManager: this._permissionManager,
        rendermime: this._rendermime,
        userId: this._currentUserId,
        visible: true
      };

      // Re-render the panel with updated props
      const newPanel = ReactWidget.create(<CommentPanel {...props} />);
      newPanel.id = this._panelWidget.id;
      newPanel.title.label = this._panelWidget.title.label;
      newPanel.title.closable = this._panelWidget.title.closable;

      // Replace the content
      this._panelWidget.dispose();
      this._panelWidget = newPanel;
    }

    // Make sure panel is visible
    if (this._panelWidget && !this._panelWidget.isVisible) {
      this._panelWidget.show();
    }
  }

  /**
   * Add a comment to a specific cell
   */
  async addComment(cellId: string, content: string, parentId?: string): Promise<void> {
    try {
      // Check permissions first
      const canEdit = await this._permissionManager.canEdit(this._currentUserId);
      if (!canEdit) {
        throw new Error('Permission denied: Cannot add comments');
      }

      // Add comment through the store
      if (parentId) {
        await this._commentStore.addReply(parentId, content);
      } else {
        await this._commentStore.create(cellId, content);
      }

      // Show comments panel for this cell
      await this.showComments(cellId);

      // Update any existing indicators for this cell
      this._updateIndicatorForCell(cellId);

    } catch (error) {
      console.error('Error adding comment:', error);
      throw error;
    }
  }

  /**
   * Resolve a comment by ID
   */
  async resolveComment(commentId: string): Promise<void> {
    try {
      // Check permissions first
      const canEdit = await this._permissionManager.canEdit(this._currentUserId);
      if (!canEdit) {
        throw new Error('Permission denied: Cannot resolve comments');
      }

      // Resolve comment through the store
      await this._commentStore.resolveComment(commentId);

      // Get the comment to find its cell
      const comment = await this._commentStore.getCommentById(commentId);
      if (comment && comment.cellId) {
        // Update indicator for this cell
        this._updateIndicatorForCell(comment.cellId);
      }

    } catch (error) {
      console.error('Error resolving comment:', error);
      throw error;
    }
  }

  /**
   * Create a comment indicator widget for a specific cell
   */
  createIndicator(cellId: string, cell: Cell): ReactWidget {
    const existingIndicator = this._indicators.get(cellId);
    if (existingIndicator) {
      return existingIndicator;
    }

    const indicator = ReactWidget.create(
      <CommentIndicatorContainer
        cellId={cellId}
        cell={cell}
        commentStore={this._commentStore}
        translator={this._translator}
        onCommentClick={(cellId) => this.showComments(cellId)}
      />
    );

    indicator.id = `comment-indicator-${cellId}`;
    indicator.addClass('jp-CommentIndicator-widget');

    this._indicators.set(cellId, indicator);
    return indicator;
  }

  /**
   * Update the comment indicator for a specific cell
   */
  private async _updateIndicatorForCell(cellId: string): Promise<void> {
    const indicator = this._indicators.get(cellId);
    if (indicator && this._commentStore) {
      try {
        // Update the indicator component (this would require a state management approach)
        // For now, we'll recreate it
        const currentNotebook = this._notebookTracker.currentWidget;
        if (currentNotebook) {
          const cells = currentNotebook.content.widgets;
          const cell = cells.find(c => c.model.id === cellId);
          if (cell) {
            const newIndicator = this.createIndicator(cellId, cell);
            indicator.dispose();
            this._indicators.set(cellId, newIndicator);
          }
        }
      } catch (error) {
        console.error('Error updating indicator:', error);
      }
    }
  }

  /**
   * Dispose of all comment system resources
   */
  dispose(): void {
    if (this._panelWidget) {
      this._panelWidget.dispose();
      this._panelWidget = null;
    }

    this._indicators.forEach(indicator => indicator.dispose());
    this._indicators.clear();
  }
}

/**
 * Container component for CommentIndicator that manages dynamic state
 */
function CommentIndicatorContainer(props: {
  cellId: string;
  cell: Cell;
  commentStore: ICommentStore;
  translator: ITranslator;
  onCommentClick: (cellId: string) => void;
}): JSX.Element {
  const { cellId, cell, commentStore, translator, onCommentClick } = props;

  const [commentCount, setCommentCount] = useState(0);
  const [hasUnresolved, setHasUnresolved] = useState(false);
  const [loading, setLoading] = useState(true);

  // Load comment data
  useEffect(() => {
    const loadCommentData = async () => {
      try {
        setLoading(true);
        const comments = await commentStore.getCommentsByCell(cellId);
        const count = comments ? comments.length : 0;
        const unresolved = comments ? comments.some((c: any) => !c.isResolved) : false;

        setCommentCount(count);
        setHasUnresolved(unresolved);
      } catch (error) {
        console.error('Error loading comment data:', error);
        setCommentCount(0);
        setHasUnresolved(false);
      } finally {
        setLoading(false);
      }
    };

    loadCommentData();

    // Subscribe to comment changes
    if (commentStore.subscribeToNotifications) {
      const unsubscribe = commentStore.subscribeToNotifications((comment: any, action: string) => {
        if (comment?.cellId === cellId) {
          loadCommentData();
        }
      });

      return unsubscribe;
    }
  }, [cellId, commentStore]);

  if (loading || commentCount === 0) {
    return <div />;
  }

  return (
    <CommentIndicator
      cellId={cellId}
      commentCount={commentCount}
      hasUnresolved={hasUnresolved}
      cell={cell}
      commentStore={commentStore}
      translator={translator}
      onClick={onCommentClick}
      showPreview={true}
    />
  );
}
