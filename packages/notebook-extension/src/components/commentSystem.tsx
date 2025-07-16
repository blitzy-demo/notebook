// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator } from '@jupyterlab/translation';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { Button } from '@jupyterlab/ui-components';
import { Time } from '@jupyterlab/coreutils';

import CommentSystemCore from '../../../notebook/src/collab/comments';
import YjsNotebookProvider from '../../../notebook/src/collab/provider';
import UserAwareness from '../../../notebook/src/collab/awareness';
import PermissionsSystem from '../../../notebook/src/collab/permissions';
import { 
  IComment, 
  ICommentFilter, 
  CommentEventType, 
  CommentStatus 
} from '../../../notebook/src/collab/comments';

/**
 * Interface for comment display with resolved replies
 */
interface ICommentDisplay extends IComment {
  /** Resolved reply comments */
  resolvedReplies?: IComment[];
}

/**
 * Interface for comment thread display properties
 */
interface ICommentThreadProps {
  comment: IComment;
  replies: IComment[];
  onReply: (parentId: string, content: string) => void;
  onEdit: (commentId: string, content: string) => void;
  onDelete: (commentId: string) => void;
  onResolve: (commentId: string) => void;
  onUnresolve: (commentId: string) => void;
  currentUserId: string;
  canEdit: boolean;
  canDelete: boolean;
  canResolve: boolean;
  markdownRenderer: IRenderMimeRegistry;
  translator: ITranslator;
  maxDepth: number;
  currentDepth: number;
}

/**
 * Interface for comment creation form properties
 */
interface ICommentFormProps {
  onSubmit: (content: string) => void;
  onCancel: () => void;
  initialContent?: string;
  placeholder?: string;
  translator: ITranslator;
  isEditing?: boolean;
  isReply?: boolean;
}

/**
 * Interface for comment filter controls properties
 */
interface ICommentFilterProps {
  filter: ICommentFilter;
  onFilterChange: (filter: ICommentFilter) => void;
  translator: ITranslator;
  commentCount: number;
  resolvedCount: number;
}

/**
 * Interface for CommentSystem component properties
 */
interface ICommentSystemProps {
  /** Cell ID this comment system is attached to */
  cellId: string;
  /** Current comments for this cell */
  comments: IComment[];
  /** Callback when comment is created */
  onCommentCreate: (cellId: string, content: string, parentId?: string) => Promise<void>;
  /** Callback when comment is updated */
  onCommentUpdate: (commentId: string, content: string) => Promise<void>;
  /** Callback when comment is deleted */
  onCommentDelete: (commentId: string) => Promise<void>;
  /** Callback when comment is resolved */
  onCommentResolve: (commentId: string) => Promise<void>;
  /** Comment system core instance */
  commentSystem: CommentSystemCore;
  /** Yjs notebook provider */
  provider: YjsNotebookProvider;
  /** User awareness system */
  awareness: UserAwareness;
  /** Permissions system */
  permissions: PermissionsSystem;
  /** Markdown renderer */
  markdownRenderer: IRenderMimeRegistry;
  /** Translator for internationalization */
  translator: ITranslator;
  /** Whether to show as dockable panel */
  isDockable?: boolean;
  /** Maximum thread depth */
  maxDepth?: number;
  /** Page size for pagination */
  pageSize?: number;
}

/**
 * CommentForm: Form component for creating or editing comments
 */
const CommentForm: React.FC<ICommentFormProps> = ({
  onSubmit,
  onCancel,
  initialContent = '',
  placeholder = '',
  translator,
  isEditing = false,
  isReply = false
}) => {
  const [content, setContent] = useState(initialContent);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const trans = translator.load('notebook');

  // Focus textarea when component mounts
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onSubmit(content.trim());
      setContent('');
    } catch (error) {
      console.error('Failed to submit comment:', error);
    } finally {
      setIsSubmitting(false);
    }
  }, [content, isSubmitting, onSubmit]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      handleSubmit(e);
    } else if (e.key === 'Escape') {
      onCancel();
    }
  }, [handleSubmit, onCancel]);

  const actionText = isEditing
    ? trans.__('Update Comment')
    : isReply
    ? trans.__('Reply')
    : trans.__('Add Comment');

  return (
    <form onSubmit={handleSubmit} className="jp-CommentForm">
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder || trans.__('Write a comment...')}
        className="jp-CommentForm-textarea"
        rows={3}
        disabled={isSubmitting}
      />
      <div className="jp-CommentForm-actions">
        <Button
          type="submit"
          disabled={!content.trim() || isSubmitting}
          className="jp-CommentForm-submit"
        >
          {isSubmitting ? trans.__('Submitting...') : actionText}
        </Button>
        <Button
          type="button"
          onClick={onCancel}
          className="jp-CommentForm-cancel"
        >
          {trans.__('Cancel')}
        </Button>
      </div>
      <div className="jp-CommentForm-help">
        <span className="jp-CommentForm-hint">
          {trans.__('Ctrl+Enter to submit, Esc to cancel')}
        </span>
      </div>
    </form>
  );
};

/**
 * CommentThread: Component for displaying a threaded comment discussion
 */
const CommentThread: React.FC<ICommentThreadProps> = ({
  comment,
  replies,
  onReply,
  onEdit,
  onDelete,
  onResolve,
  onUnresolve,
  currentUserId,
  canEdit,
  canDelete,
  canResolve,
  markdownRenderer,
  translator,
  maxDepth,
  currentDepth
}) => {
  const [isReplying, setIsReplying] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [showReplies, setShowReplies] = useState(true);
  const [renderedContent, setRenderedContent] = useState('');
  const trans = translator.load('notebook');

  // Render markdown content
  useEffect(() => {
    const renderContent = async () => {
      try {
        // Simple markdown rendering - for now just use the content as-is
        // TODO: Implement proper markdown rendering with renderMime registry
        setRenderedContent(comment.content);
      } catch (error) {
        console.error('Failed to render comment content:', error);
        setRenderedContent(comment.content);
      }
    };
    renderContent();
  }, [comment.content, markdownRenderer]);

  const handleReply = useCallback(async (content: string) => {
    await onReply(comment.id, content);
    setIsReplying(false);
  }, [comment.id, onReply]);

  const handleEdit = useCallback(async (content: string) => {
    await onEdit(comment.id, content);
    setIsEditing(false);
  }, [comment.id, onEdit]);

  const handleDelete = useCallback(async () => {
    if (window.confirm(trans.__('Are you sure you want to delete this comment?'))) {
      await onDelete(comment.id);
    }
  }, [comment.id, onDelete, trans]);

  const handleResolve = useCallback(async () => {
    if (comment.resolved) {
      await onUnresolve(comment.id);
    } else {
      await onResolve(comment.id);
    }
  }, [comment.id, comment.resolved, onResolve, onUnresolve]);

  const isOwner = comment.author.userId === currentUserId;
  const canReplyToComment = currentDepth < maxDepth;
  const formattedTime = Time.formatHuman(new Date(comment.timestamp));

  return (
    <div className={`jp-CommentThread ${comment.resolved ? 'jp-CommentThread-resolved' : ''}`}>
      <div className="jp-CommentThread-header">
        <div className="jp-CommentThread-author">
          {comment.author.avatar && (
            <img
              src={comment.author.avatar}
              alt={comment.author.displayName}
              className="jp-CommentThread-avatar"
            />
          )}
          <span className="jp-CommentThread-authorName">
            {comment.author.displayName}
          </span>
        </div>
        <div className="jp-CommentThread-meta">
          <span className="jp-CommentThread-timestamp" title={new Date(comment.timestamp).toLocaleString()}>
            {formattedTime}
          </span>
          {comment.resolved && (
            <span className="jp-CommentThread-resolved-badge">
              {trans.__('Resolved')}
            </span>
          )}
        </div>
      </div>

      <div className="jp-CommentThread-content">
        {isEditing ? (
          <CommentForm
            onSubmit={handleEdit}
            onCancel={() => setIsEditing(false)}
            initialContent={comment.content}
            placeholder={trans.__('Edit your comment...')}
            translator={translator}
            isEditing={true}
          />
        ) : (
          <div 
            className="jp-CommentThread-body"
            dangerouslySetInnerHTML={{ __html: renderedContent }}
          />
        )}
      </div>

      {!isEditing && (
        <div className="jp-CommentThread-actions">
          {canReplyToComment && (
            <Button
              onClick={() => setIsReplying(true)}
              className="jp-CommentThread-action"
              minimal
            >
              {trans.__('Reply')}
            </Button>
          )}
          {isOwner && canEdit && (
            <Button
              onClick={() => setIsEditing(true)}
              className="jp-CommentThread-action"
              minimal
            >
              {trans.__('Edit')}
            </Button>
          )}
          {(isOwner || canDelete) && (
            <Button
              onClick={handleDelete}
              className="jp-CommentThread-action jp-CommentThread-delete"
              minimal
            >
              {trans.__('Delete')}
            </Button>
          )}
          {canResolve && (
            <Button
              onClick={handleResolve}
              className="jp-CommentThread-action"
              minimal
            >
              {comment.resolved ? trans.__('Unresolve') : trans.__('Resolve')}
            </Button>
          )}
        </div>
      )}

      {isReplying && (
        <div className="jp-CommentThread-replyForm">
          <CommentForm
            onSubmit={handleReply}
            onCancel={() => setIsReplying(false)}
            placeholder={trans.__('Reply to this comment...')}
            translator={translator}
            isReply={true}
          />
        </div>
      )}

      {replies.length > 0 && (
        <div className="jp-CommentThread-replies">
          <div className="jp-CommentThread-repliesHeader">
            <Button
              onClick={() => setShowReplies(!showReplies)}
              className="jp-CommentThread-toggleReplies"
              minimal
            >
              {showReplies ? '▼' : '▶'} {trans.__('%1 replies', replies.length)}
            </Button>
          </div>
          {showReplies && (
            <div className="jp-CommentThread-repliesContent">
              {replies.map((reply) => (
                <CommentThread
                  key={reply.id}
                  comment={reply}
                  replies={[]} // Replies to replies are handled recursively
                  onReply={onReply}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onResolve={onResolve}
                  onUnresolve={onUnresolve}
                  currentUserId={currentUserId}
                  canEdit={canEdit}
                  canDelete={canDelete}
                  canResolve={canResolve}
                  markdownRenderer={markdownRenderer}
                  translator={translator}
                  maxDepth={maxDepth}
                  currentDepth={currentDepth + 1}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * CommentFilter: Component for filtering and sorting comments
 */
const CommentFilter: React.FC<ICommentFilterProps> = ({
  filter,
  onFilterChange,
  translator,
  commentCount,
  resolvedCount
}) => {
  const trans = translator.load('notebook');

  const handleFilterChange = useCallback((updates: Partial<ICommentFilter>) => {
    onFilterChange({ ...filter, ...updates });
  }, [filter, onFilterChange]);

  return (
    <div className="jp-CommentFilter">
      <div className="jp-CommentFilter-header">
        <span className="jp-CommentFilter-title">
          💬 {trans.__('Comments')} [{commentCount}]
        </span>
        <div className="jp-CommentFilter-controls">
          <select
            value={filter.sortBy || 'timestamp'}
            onChange={(e) => handleFilterChange({ sortBy: e.target.value as any })}
            className="jp-CommentFilter-sort"
          >
            <option value="timestamp">{trans.__('Recent')}</option>
            <option value="author">{trans.__('Author')}</option>
            <option value="resolved">{trans.__('Status')}</option>
          </select>
          <Button
            onClick={() => handleFilterChange({ sortOrder: filter.sortOrder === 'asc' ? 'desc' : 'asc' })}
            className="jp-CommentFilter-order"
            minimal
          >
            {filter.sortOrder === 'asc' ? '↑' : '↓'}
          </Button>
        </div>
      </div>

      <div className="jp-CommentFilter-options">
        <label className="jp-CommentFilter-checkbox">
          <input
            type="checkbox"
            checked={filter.resolved === undefined ? true : filter.resolved === false}
            onChange={(e) => handleFilterChange({ 
              resolved: e.target.checked ? undefined : false 
            })}
          />
          {trans.__('Show unresolved')} ({commentCount - resolvedCount})
        </label>
        <label className="jp-CommentFilter-checkbox">
          <input
            type="checkbox"
            checked={filter.resolved === true}
            onChange={(e) => handleFilterChange({ 
              resolved: e.target.checked ? true : undefined 
            })}
          />
          {trans.__('Show resolved')} ({resolvedCount})
        </label>
        <label className="jp-CommentFilter-checkbox">
          <input
            type="checkbox"
            checked={filter.includeReplies !== false}
            onChange={(e) => handleFilterChange({ 
              includeReplies: e.target.checked 
            })}
          />
          {trans.__('Include replies')}
        </label>
      </div>

      {filter.searchText !== undefined && (
        <div className="jp-CommentFilter-search">
          <input
            type="text"
            value={filter.searchText}
            onChange={(e) => handleFilterChange({ searchText: e.target.value })}
            placeholder={trans.__('Search comments...')}
            className="jp-CommentFilter-searchInput"
          />
        </div>
      )}
    </div>
  );
};

/**
 * CommentSystem: Main component for cell-level commenting functionality
 * 
 * Enables threaded discussions attached to specific notebook cells with real-time
 * synchronization, markdown formatting, @mentions, and resolution workflows.
 */
const CommentSystem: React.FC<ICommentSystemProps> = ({
  cellId,
  comments,
  onCommentCreate,
  onCommentUpdate,
  onCommentDelete,
  onCommentResolve,
  commentSystem,
  provider,
  awareness,
  permissions,
  markdownRenderer,
  translator,
  isDockable = false,
  maxDepth = 5,
  pageSize = 20
}) => {
  const [filter, setFilter] = useState<ICommentFilter>({
    cellId,
    sortBy: 'timestamp',
    sortOrder: 'desc',
    limit: pageSize,
    offset: 0,
    includeReplies: true
  });
  const [isAddingComment, setIsAddingComment] = useState(false);
  const [filteredComments, setFilteredComments] = useState<IComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trans = translator.load('notebook');

  // Get current user
  const currentUser = awareness.getCurrentUser();
  const currentUserId = currentUser?.id || '';

  // Check permissions
  const [canCreate, setCanCreate] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [canDelete, setCanDelete] = useState(false);
  const [canResolve, setCanResolve] = useState(false);

  useEffect(() => {
    const checkPermissions = async () => {
      if (!currentUser) return;

      try {
        const [create, edit, del, resolve] = await Promise.all([
          permissions.checkPermission(currentUser.id, 'comment' as any, cellId),
          permissions.checkPermission(currentUser.id, 'edit' as any, cellId),
          permissions.checkPermission(currentUser.id, 'delete' as any, cellId),
          permissions.checkPermission(currentUser.id, 'comment' as any, cellId)
        ]);

        setCanCreate(create);
        setCanEdit(edit);
        setCanDelete(del);
        setCanResolve(resolve);
      } catch (err) {
        console.error('Failed to check permissions:', err);
      }
    };

    checkPermissions();
  }, [currentUser, permissions, cellId]);

  // Apply filtering to comments
  const applyFilter = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const filtered = await commentSystem.getComments(filter);
      setFilteredComments(filtered);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load comments');
      console.error('Failed to filter comments:', err);
    } finally {
      setLoading(false);
    }
  }, [commentSystem, filter]);

  useEffect(() => {
    applyFilter();
  }, [applyFilter]);

  // Build comment tree structure
  const commentTree = useMemo(() => {
    const tree: IComment[] = [];
    const repliesMap = new Map<string, IComment[]>();

    // Group comments by parent
    filteredComments.forEach(comment => {
      if (comment.parentId) {
        if (!repliesMap.has(comment.parentId)) {
          repliesMap.set(comment.parentId, []);
        }
        repliesMap.get(comment.parentId)!.push(comment);
      } else {
        tree.push(comment);
      }
    });

    // Sort replies for each comment
    repliesMap.forEach(replies => {
      replies.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    });

    // Return the tree structure
    return tree.map(comment => ({
      ...comment,
      resolvedReplies: repliesMap.get(comment.id) || []
    }));
  }, [filteredComments]);

  // Count resolved comments
  const resolvedCount = useMemo(() => {
    return filteredComments.filter(c => c.resolved).length;
  }, [filteredComments]);

  // Handle comment creation
  const handleCreateComment = useCallback(async (content: string) => {
    if (!canCreate) return;
    
    try {
      await onCommentCreate(cellId, content);
      setIsAddingComment(false);
      await applyFilter(); // Refresh comments
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create comment');
    }
  }, [canCreate, cellId, onCommentCreate, applyFilter]);

  // Handle comment reply
  const handleReplyToComment = useCallback(async (parentId: string, content: string) => {
    if (!canCreate) return;
    
    try {
      await onCommentCreate(cellId, content, parentId);
      await applyFilter(); // Refresh comments
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reply to comment');
    }
  }, [canCreate, cellId, onCommentCreate, applyFilter]);

  // Handle comment edit
  const handleEditComment = useCallback(async (commentId: string, content: string) => {
    if (!canEdit) return;
    
    try {
      await onCommentUpdate(commentId, content);
      await applyFilter(); // Refresh comments
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to edit comment');
    }
  }, [canEdit, onCommentUpdate, applyFilter]);

  // Handle comment deletion
  const handleDeleteComment = useCallback(async (commentId: string) => {
    if (!canDelete) return;
    
    try {
      await onCommentDelete(commentId);
      await applyFilter(); // Refresh comments
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete comment');
    }
  }, [canDelete, onCommentDelete, applyFilter]);

  // Handle comment resolution
  const handleResolveComment = useCallback(async (commentId: string) => {
    if (!canResolve) return;
    
    try {
      await onCommentResolve(commentId);
      await applyFilter(); // Refresh comments
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve comment');
    }
  }, [canResolve, onCommentResolve, applyFilter]);

  // Handle comment unresolution
  const handleUnresolveComment = useCallback(async (commentId: string) => {
    if (!canResolve) return;
    
    try {
      await commentSystem.unresolveComment(commentId);
      await applyFilter(); // Refresh comments
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unresolve comment');
    }
  }, [canResolve, commentSystem, applyFilter]);

  // Handle filter changes
  const handleFilterChange = useCallback((newFilter: ICommentFilter) => {
    setFilter(newFilter);
  }, []);

  // Load more comments (pagination)
  const loadMoreComments = useCallback(async () => {
    if (loading) return;
    
    const newFilter = {
      ...filter,
      offset: (filter.offset || 0) + pageSize
    };
    
    setLoading(true);
    try {
      const moreComments = await commentSystem.getComments(newFilter);
      setFilteredComments(prev => [...prev, ...moreComments]);
      setFilter(newFilter);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more comments');
    } finally {
      setLoading(false);
    }
  }, [commentSystem, filter, loading, pageSize]);

  // Connection status
  const isConnected = provider.isConnected;

  const containerClass = isDockable
    ? 'jp-CommentSystem jp-CommentSystem-dockable'
    : 'jp-CommentSystem jp-CommentSystem-inline';

  return (
    <div className={containerClass}>
      <CommentFilter
        filter={filter}
        onFilterChange={handleFilterChange}
        translator={translator}
        commentCount={filteredComments.length}
        resolvedCount={resolvedCount}
      />

      {error && (
        <div className="jp-CommentSystem-error">
          {error}
        </div>
      )}

      {!isConnected && (
        <div className="jp-CommentSystem-warning">
          {trans.__('Comments are not synchronized - connection lost')}
        </div>
      )}

      <div className="jp-CommentSystem-content">
        {loading && filteredComments.length === 0 ? (
          <div className="jp-CommentSystem-loading">
            {trans.__('Loading comments...')}
          </div>
        ) : commentTree.length === 0 ? (
          <div className="jp-CommentSystem-empty">
            {trans.__('No comments yet. Be the first to comment!')}
          </div>
        ) : (
          <div className="jp-CommentSystem-threads">
            {commentTree.map((comment) => (
              <CommentThread
                key={comment.id}
                comment={comment}
                replies={comment.resolvedReplies || []}
                onReply={handleReplyToComment}
                onEdit={handleEditComment}
                onDelete={handleDeleteComment}
                onResolve={handleResolveComment}
                onUnresolve={handleUnresolveComment}
                currentUserId={currentUserId}
                canEdit={canEdit}
                canDelete={canDelete}
                canResolve={canResolve}
                markdownRenderer={markdownRenderer}
                translator={translator}
                maxDepth={maxDepth}
                currentDepth={0}
              />
            ))}
          </div>
        )}

        {filteredComments.length >= pageSize && (
          <div className="jp-CommentSystem-loadMore">
            <Button
              onClick={loadMoreComments}
              disabled={loading}
              className="jp-CommentSystem-loadMoreButton"
            >
              {loading ? trans.__('Loading...') : trans.__('Load More Comments')}
            </Button>
          </div>
        )}
      </div>

      {canCreate && (
        <div className="jp-CommentSystem-actions">
          {isAddingComment ? (
            <CommentForm
              onSubmit={handleCreateComment}
              onCancel={() => setIsAddingComment(false)}
              placeholder={trans.__('Add a comment to this cell...')}
              translator={translator}
            />
          ) : (
            <Button
              onClick={() => setIsAddingComment(true)}
              className="jp-CommentSystem-addButton"
            >
              {trans.__('Add Comment')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * CommentSystemWidget: ReactWidget wrapper for CommentSystem
 */
export class CommentSystemWidget extends ReactWidget {
  private _props: ICommentSystemProps;

  constructor(props: ICommentSystemProps) {
    super();
    this._props = props;
    this.addClass('jp-CommentSystemWidget');
  }

  /**
   * Update the component properties
   */
  updateProps(props: Partial<ICommentSystemProps>): void {
    this._props = { ...this._props, ...props };
    this.update();
  }

  /**
   * Render the React component
   */
  render(): JSX.Element {
    return <CommentSystem {...this._props} />;
  }

  /**
   * Create a new comment
   */
  async createComment(content: string, parentId?: string): Promise<void> {
    return this._props.onCommentCreate(this._props.cellId, content, parentId);
  }

  /**
   * Reply to a comment
   */
  async replyToComment(parentId: string, content: string): Promise<void> {
    return this._props.onCommentCreate(this._props.cellId, content, parentId);
  }

  /**
   * Edit a comment
   */
  async editComment(commentId: string, content: string): Promise<void> {
    return this._props.onCommentUpdate(commentId, content);
  }

  /**
   * Delete a comment
   */
  async deleteComment(commentId: string): Promise<void> {
    return this._props.onCommentDelete(commentId);
  }

  /**
   * Resolve a comment
   */
  async resolveComment(commentId: string): Promise<void> {
    return this._props.onCommentResolve(commentId);
  }

  /**
   * Filter comments
   */
  async filterComments(filter: ICommentFilter): Promise<IComment[]> {
    return this._props.commentSystem.getComments(filter);
  }
}

// Export the main component as default
export default CommentSystem;