// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { ReactWidget } from '@jupyterlab/apputils';

import { NotebookPanel, INotebookTracker } from '@jupyterlab/notebook';

import { ITranslator } from '@jupyterlab/translation';

import { Signal, ISignal } from '@lumino/signaling';

import React, {
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
  KeyboardEvent
} from 'react';

import * as Y from 'yjs';

/**
 * Comment interface representing a single comment in the thread
 */
export interface IComment {
  id: string;
  cellId: string;
  author: {
    id: string;
    name: string;
    avatar?: string;
  };
  content: string;
  timestamp: Date;
  parentId?: string; // For threaded replies
  resolved: boolean;
  reactions?: { [emoji: string]: string[] }; // emoji -> list of user IDs
  selection?: {
    start: number;
    end: number;
    text: string;
  };
}

/**
 * Comment thread interface representing a collection of related comments
 */
export interface ICommentThread {
  id: string;
  cellId: string;
  anchor: {
    type: 'cell' | 'selection';
    cellId: string;
    selection?: {
      start: number;
      end: number;
      text: string;
    };
  };
  comments: IComment[];
  resolved: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Comment service interface for managing comments
 */
export interface ICommentService {
  readonly commentThreadsChanged: ISignal<ICommentService, ICommentThread[]>;
  readonly activeThread: ICommentThread | null;
  readonly threadsForCell: (cellId: string) => ICommentThread[];
  readonly allThreads: ICommentThread[];
  
  createThread(cellId: string, content: string, selection?: IComment['selection']): Promise<ICommentThread>;
  addComment(threadId: string, content: string, parentId?: string): Promise<IComment>;
  resolveThread(threadId: string): Promise<void>;
  unresolveThread(threadId: string): Promise<void>;
  editComment(commentId: string, content: string): Promise<void>;
  deleteComment(commentId: string): Promise<void>;
  addReaction(commentId: string, emoji: string): Promise<void>;
  removeReaction(commentId: string, emoji: string): Promise<void>;
  setActiveThread(threadId: string | null): void;
  dispose(): void;
}

/**
 * Props for the main CommentSystem component
 */
interface ICommentSystemProps {
  commentService: ICommentService;
  notebookTracker: INotebookTracker;
  translator: ITranslator;
}

/**
 * Props for individual comment thread components
 */
interface ICommentThreadProps {
  thread: ICommentThread;
  commentService: ICommentService;
  translator: ITranslator;
  isActive: boolean;
  onThreadClick: (thread: ICommentThread) => void;
}

/**
 * Props for individual comment components
 */
interface ICommentProps {
  comment: IComment;
  thread: ICommentThread;
  commentService: ICommentService;
  translator: ITranslator;
  depth: number;
}

/**
 * Comment component for displaying individual comments
 */
const CommentItem: React.FC<ICommentProps> = ({
  comment,
  thread,
  commentService,
  translator,
  depth
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(comment.content);
  const [isReplying, setIsReplying] = useState(false);
  const [replyContent, setReplyContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const replyTextareaRef = useRef<HTMLTextAreaElement>(null);
  const trans = translator.load('notebook');

  useEffect(() => {
    if (isEditing && editTextareaRef.current) {
      editTextareaRef.current.focus();
      editTextareaRef.current.setSelectionRange(
        editTextareaRef.current.value.length,
        editTextareaRef.current.value.length
      );
    }
  }, [isEditing]);

  useEffect(() => {
    if (isReplying && replyTextareaRef.current) {
      replyTextareaRef.current.focus();
    }
  }, [isReplying]);

  const handleEdit = useCallback(async () => {
    if (editContent.trim() === comment.content) {
      setIsEditing(false);
      return;
    }

    if (!editContent.trim()) {
      setError(trans.__('Comment cannot be empty'));
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      await commentService.editComment(comment.id, editContent.trim());
      setIsEditing(false);
    } catch (err) {
      setError(trans.__('Failed to update comment: %1', (err as Error).message));
    } finally {
      setIsLoading(false);
    }
  }, [commentService, comment.id, editContent, comment.content, trans]);

  const handleReply = useCallback(async () => {
    if (!replyContent.trim()) {
      setError(trans.__('Reply cannot be empty'));
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      await commentService.addComment(thread.id, replyContent.trim(), comment.id);
      setReplyContent('');
      setIsReplying(false);
    } catch (err) {
      setError(trans.__('Failed to add reply: %1', (err as Error).message));
    } finally {
      setIsLoading(false);
    }
  }, [commentService, thread.id, replyContent, comment.id, trans]);

  const handleReaction = useCallback(async (emoji: string) => {
    try {
      const currentUserReactions = comment.reactions?.[emoji] || [];
      const currentUserId = 'current-user'; // TODO: Get actual user ID from awareness service
      
      if (currentUserReactions.includes(currentUserId)) {
        await commentService.removeReaction(comment.id, emoji);
      } else {
        await commentService.addReaction(comment.id, emoji);
      }
    } catch (err) {
      setError(trans.__('Failed to update reaction: %1', (err as Error).message));
    }
  }, [commentService, comment.id, comment.reactions, trans]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>, action: 'edit' | 'reply') => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (action === 'edit') {
        handleEdit();
      } else {
        handleReply();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (action === 'edit') {
        setIsEditing(false);
        setEditContent(comment.content);
      } else {
        setIsReplying(false);
        setReplyContent('');
      }
      setError(null);
    }
  }, [handleEdit, handleReply, comment.content]);

  const replies = useMemo(() => {
    return thread.comments.filter(c => c.parentId === comment.id);
  }, [thread.comments, comment.id]);

  const formatTimestamp = (timestamp: Date) => {
    const now = new Date();
    const diffMs = now.getTime() - timestamp.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return trans.__('just now');
    if (diffMins < 60) return trans.__('%1 minutes ago', diffMins);
    if (diffHours < 24) return trans.__('%1 hours ago', diffHours);
    if (diffDays < 7) return trans.__('%1 days ago', diffDays);
    return timestamp.toLocaleDateString();
  };

  return (
    <div 
      className={`jp-CommentSystem-comment jp-CommentSystem-comment-depth-${Math.min(depth, 3)}`}
      style={{ marginLeft: `${depth * 20}px` }}
      role="article"
      aria-label={trans.__('Comment by %1', comment.author.name)}
    >
      <div className="jp-CommentSystem-comment-header">
        <div className="jp-CommentSystem-comment-author">
          {comment.author.avatar && (
            <img 
              src={comment.author.avatar} 
              alt={comment.author.name}
              className="jp-CommentSystem-comment-avatar"
              width="24"
              height="24"
            />
          )}
          <span className="jp-CommentSystem-comment-author-name">
            {comment.author.name}
          </span>
        </div>
        <div className="jp-CommentSystem-comment-timestamp">
          <time dateTime={comment.timestamp.toISOString()}>
            {formatTimestamp(comment.timestamp)}
          </time>
        </div>
        <div className="jp-CommentSystem-comment-actions">
          <button
            className="jp-CommentSystem-comment-action"
            onClick={() => {
              setIsEditing(true);
              setError(null);
            }}
            disabled={isLoading}
            title={trans.__('Edit comment (Ctrl+Click)')}
            aria-label={trans.__('Edit comment')}
          >
            ✏️
          </button>
          <button
            className="jp-CommentSystem-comment-action"
            onClick={() => {
              setIsReplying(true);
              setError(null);
            }}
            disabled={isLoading}
            title={trans.__('Reply to comment')}
            aria-label={trans.__('Reply to comment')}
          >
            💬
          </button>
        </div>
      </div>

      <div className="jp-CommentSystem-comment-content">
        {error && (
          <div className="jp-CommentSystem-error" role="alert" aria-live="polite">
            {error}
          </div>
        )}
        
        {isEditing ? (
          <div className="jp-CommentSystem-comment-edit">
            <textarea
              ref={editTextareaRef}
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              onKeyDown={(e) => handleKeyDown(e, 'edit')}
              className="jp-CommentSystem-comment-edit-textarea"
              disabled={isLoading}
              placeholder={trans.__('Edit your comment...')}
              aria-label={trans.__('Edit comment content')}
              rows={3}
            />
            <div className="jp-CommentSystem-comment-edit-actions">
              <button
                onClick={handleEdit}
                disabled={isLoading || !editContent.trim()}
                className="jp-CommentSystem-button jp-CommentSystem-button-primary"
                aria-label={trans.__('Save changes (Ctrl+Enter)')}
              >
                {isLoading ? trans.__('Saving...') : trans.__('Save')}
              </button>
              <button
                onClick={() => {
                  setIsEditing(false);
                  setEditContent(comment.content);
                  setError(null);
                }}
                disabled={isLoading}
                className="jp-CommentSystem-button jp-CommentSystem-button-secondary"
                aria-label={trans.__('Cancel editing (Escape)')}
              >
                {trans.__('Cancel')}
              </button>
            </div>
            <div className="jp-CommentSystem-keyboard-hint">
              {trans.__('Press Ctrl+Enter to save, Escape to cancel')}
            </div>
          </div>
        ) : (
          <div className="jp-CommentSystem-comment-text">
            {comment.content}
          </div>
        )}
      </div>

      {comment.selection && (
        <div className="jp-CommentSystem-comment-selection">
          <span className="jp-CommentSystem-comment-selection-label">
            {trans.__('Selected text:')}
          </span>
          <code className="jp-CommentSystem-comment-selection-text">
            {comment.selection.text}
          </code>
        </div>
      )}

      <div className="jp-CommentSystem-comment-reactions">
        {comment.reactions && Object.entries(comment.reactions).map(([emoji, users]) => (
          users.length > 0 && (
            <button
              key={emoji}
              className="jp-CommentSystem-reaction"
              onClick={() => handleReaction(emoji)}
              title={trans.__('React with %1', emoji)}
            >
              {emoji} {users.length}
            </button>
          )
        ))}
        <button
          className="jp-CommentSystem-reaction-add"
          onClick={() => handleReaction('👍')}
          title={trans.__('Add reaction')}
        >
          +
        </button>
      </div>

      {isReplying && (
        <div className="jp-CommentSystem-reply-form">
          <textarea
            ref={replyTextareaRef}
            value={replyContent}
            onChange={(e) => setReplyContent(e.target.value)}
            onKeyDown={(e) => handleKeyDown(e, 'reply')}
            placeholder={trans.__('Write a reply...')}
            className="jp-CommentSystem-reply-textarea"
            disabled={isLoading}
            aria-label={trans.__('Reply to comment')}
            rows={2}
          />
          <div className="jp-CommentSystem-reply-actions">
            <button
              onClick={handleReply}
              disabled={isLoading || !replyContent.trim()}
              className="jp-CommentSystem-button jp-CommentSystem-button-primary"
              aria-label={trans.__('Post reply (Ctrl+Enter)')}
            >
              {isLoading ? trans.__('Posting...') : trans.__('Reply')}
            </button>
            <button
              onClick={() => {
                setIsReplying(false);
                setReplyContent('');
                setError(null);
              }}
              disabled={isLoading}
              className="jp-CommentSystem-button jp-CommentSystem-button-secondary"
              aria-label={trans.__('Cancel reply (Escape)')}
            >
              {trans.__('Cancel')}
            </button>
          </div>
          <div className="jp-CommentSystem-keyboard-hint">
            {trans.__('Press Ctrl+Enter to reply, Escape to cancel')}
          </div>
        </div>
      )}

      {replies.length > 0 && (
        <div className="jp-CommentSystem-replies">
          {replies.map(reply => (
            <CommentItem
              key={reply.id}
              comment={reply}
              thread={thread}
              commentService={commentService}
              translator={translator}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Comment thread component for displaying a complete thread
 */
const CommentThread: React.FC<ICommentThreadProps> = ({
  thread,
  commentService,
  translator,
  isActive,
  onThreadClick
}) => {
  const [isExpanded, setIsExpanded] = useState(isActive);
  const [newCommentContent, setNewCommentContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const newCommentTextareaRef = useRef<HTMLTextAreaElement>(null);
  const trans = translator.load('notebook');

  useEffect(() => {
    setIsExpanded(isActive);
  }, [isActive]);

  const handleResolve = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      if (thread.resolved) {
        await commentService.unresolveThread(thread.id);
      } else {
        await commentService.resolveThread(thread.id);
      }
    } catch (err) {
      setError(trans.__('Failed to update thread status: %1', (err as Error).message));
    } finally {
      setIsLoading(false);
    }
  }, [commentService, thread.id, thread.resolved, trans]);

  const handleAddComment = useCallback(async () => {
    if (!newCommentContent.trim()) {
      setError(trans.__('Comment cannot be empty'));
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      await commentService.addComment(thread.id, newCommentContent.trim());
      setNewCommentContent('');
    } catch (err) {
      setError(trans.__('Failed to add comment: %1', (err as Error).message));
    } finally {
      setIsLoading(false);
    }
  }, [commentService, thread.id, newCommentContent, trans]);

  const handleNewCommentKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      handleAddComment();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setNewCommentContent('');
      setError(null);
    }
  }, [handleAddComment]);

  const rootComments = useMemo(() => {
    return thread.comments.filter(c => !c.parentId);
  }, [thread.comments]);

  const commentCount = thread.comments.length;
  const unresolvedCount = thread.comments.filter(c => !c.resolved).length;

  return (
    <div 
      className={`jp-CommentSystem-thread ${isActive ? 'jp-CommentSystem-thread-active' : ''} ${thread.resolved ? 'jp-CommentSystem-thread-resolved' : ''}`}
      role="region"
      aria-label={trans.__('Comment thread with %1 comments', commentCount)}
    >
      {error && (
        <div className="jp-CommentSystem-error" role="alert" aria-live="polite">
          {error}
        </div>
      )}

      <div 
        className="jp-CommentSystem-thread-header"
        onClick={() => {
          onThreadClick(thread);
          setIsExpanded(!isExpanded);
          setError(null);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onThreadClick(thread);
            setIsExpanded(!isExpanded);
          }
        }}
        aria-expanded={isExpanded}
        aria-controls={`thread-content-${thread.id}`}
      >
        <div className="jp-CommentSystem-thread-info">
          <span className="jp-CommentSystem-thread-count">
            {commentCount} {commentCount === 1 ? trans.__('comment') : trans.__('comments')}
          </span>
          {thread.anchor.selection && (
            <span className="jp-CommentSystem-thread-selection-indicator">
              📌 {trans.__('Text selection')}
            </span>
          )}
          {thread.resolved && (
            <span className="jp-CommentSystem-thread-resolved-badge">
              {trans.__('Resolved')}
            </span>
          )}
        </div>
        <div className="jp-CommentSystem-thread-actions">
          <button
            className={`jp-CommentSystem-thread-resolve ${thread.resolved ? 'jp-CommentSystem-thread-resolved' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              handleResolve();
            }}
            disabled={isLoading}
            title={thread.resolved ? trans.__('Unresolve thread') : trans.__('Resolve thread')}
            aria-label={thread.resolved ? trans.__('Mark thread as unresolved') : trans.__('Mark thread as resolved')}
          >
            {isLoading ? '⏳' : (thread.resolved ? '✅' : '⭕')}
          </button>
          <button
            className="jp-CommentSystem-thread-expand"
            title={isExpanded ? trans.__('Collapse thread') : trans.__('Expand thread')}
            aria-label={isExpanded ? trans.__('Collapse thread') : trans.__('Expand thread')}
          >
            {isExpanded ? '▼' : '▶'}
          </button>
        </div>
      </div>

      {isExpanded && (
        <div 
          id={`thread-content-${thread.id}`}
          className="jp-CommentSystem-thread-content"
          role="region"
          aria-label={trans.__('Thread content')}
        >
          <div className="jp-CommentSystem-thread-comments">
            {rootComments.map(comment => (
              <CommentItem
                key={comment.id}
                comment={comment}
                thread={thread}
                commentService={commentService}
                translator={translator}
                depth={0}
              />
            ))}
          </div>

          {!thread.resolved && (
            <div className="jp-CommentSystem-thread-new-comment">
              <textarea
                ref={newCommentTextareaRef}
                value={newCommentContent}
                onChange={(e) => setNewCommentContent(e.target.value)}
                onKeyDown={handleNewCommentKeyDown}
                placeholder={trans.__('Add a comment...')}
                className="jp-CommentSystem-new-comment-textarea"
                disabled={isLoading}
                aria-label={trans.__('Add new comment to thread')}
                rows={2}
              />
              <div className="jp-CommentSystem-new-comment-actions">
                <button
                  onClick={handleAddComment}
                  disabled={isLoading || !newCommentContent.trim()}
                  className="jp-CommentSystem-button jp-CommentSystem-button-primary"
                  aria-label={trans.__('Post comment (Ctrl+Enter)')}
                >
                  {isLoading ? trans.__('Posting...') : trans.__('Comment')}
                </button>
              </div>
              <div className="jp-CommentSystem-keyboard-hint">
                {trans.__('Press Ctrl+Enter to post, Escape to clear')}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Main CommentSystem component
 */
const CommentSystemPanel: React.FC<ICommentSystemProps> = ({
  commentService,
  notebookTracker,
  translator
}) => {
  const [threads, setThreads] = useState<ICommentThread[]>([]);
  const [currentNotebook, setCurrentNotebook] = useState<NotebookPanel | null>(null);
  const [activeThread, setActiveThread] = useState<ICommentThread | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [filterByCellId, setFilterByCellId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const trans = translator.load('notebook');

  // Update threads when comment service changes
  useEffect(() => {
    const updateThreads = () => {
      setThreads([...commentService.allThreads]);
      setActiveThread(commentService.activeThread);
    };

    updateThreads();
    commentService.commentThreadsChanged.connect(updateThreads);

    return () => {
      commentService.commentThreadsChanged.disconnect(updateThreads);
    };
  }, [commentService]);

  // Track current notebook
  useEffect(() => {
    const updateCurrentNotebook = () => {
      setCurrentNotebook(notebookTracker.currentWidget);
    };

    updateCurrentNotebook();
    notebookTracker.currentChanged.connect(updateCurrentNotebook);

    return () => {
      notebookTracker.currentChanged.disconnect(updateCurrentNotebook);
    };
  }, [notebookTracker]);

  // Filter threads based on current settings
  const filteredThreads = useMemo(() => {
    let filtered = threads;

    if (!showResolved) {
      filtered = filtered.filter(thread => !thread.resolved);
    }

    if (filterByCellId) {
      filtered = filtered.filter(thread => thread.cellId === filterByCellId);
    }

    if (searchTerm.trim()) {
      const searchLower = searchTerm.toLowerCase();
      filtered = filtered.filter(thread => 
        thread.comments.some(comment => 
          comment.content.toLowerCase().includes(searchLower) ||
          comment.author.name.toLowerCase().includes(searchLower)
        )
      );
    }

    return filtered.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }, [threads, showResolved, filterByCellId, searchTerm]);

  const handleThreadClick = useCallback((thread: ICommentThread) => {
    commentService.setActiveThread(thread.id === activeThread?.id ? null : thread.id);
  }, [commentService, activeThread]);

  const handleCreateNewThread = useCallback(async () => {
    if (!currentNotebook) {
      setError(trans.__('No notebook is currently open'));
      return;
    }

    const activeCell = currentNotebook.content.activeCell;
    if (!activeCell) {
      setError(trans.__('No cell is currently selected'));
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const cellId = activeCell.model.id;
      const content = trans.__('New comment thread');
      
      await commentService.createThread(cellId, content);
    } catch (err) {
      setError(trans.__('Failed to create comment thread: %1', (err as Error).message));
    } finally {
      setIsLoading(false);
    }
  }, [commentService, currentNotebook, trans]);

  const resolvedCount = threads.filter(t => t.resolved).length;
  const unresolvedCount = threads.filter(t => !t.resolved).length;

  return (
    <div className="jp-CommentSystem" role="main">
      <div className="jp-CommentSystem-header">
        <h3 className="jp-CommentSystem-title" id="comments-heading">
          {trans.__('Comments')}
        </h3>
        <div className="jp-CommentSystem-stats" aria-live="polite">
          <span className="jp-CommentSystem-stat">
            {unresolvedCount} {trans.__('active')}
          </span>
          {resolvedCount > 0 && (
            <span className="jp-CommentSystem-stat">
              {resolvedCount} {trans.__('resolved')}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="jp-CommentSystem-error" role="alert" aria-live="polite">
          {error}
          <button 
            onClick={() => setError(null)}
            className="jp-CommentSystem-error-dismiss"
            aria-label={trans.__('Dismiss error')}
          >
            ×
          </button>
        </div>
      )}

      <div className="jp-CommentSystem-controls">
        <button
          onClick={handleCreateNewThread}
          disabled={!currentNotebook || isLoading}
          className="jp-CommentSystem-button jp-CommentSystem-button-primary"
          title={trans.__('Create new comment thread on active cell')}
          aria-label={trans.__('Create new comment thread')}
        >
          {isLoading ? trans.__('Creating...') : trans.__('New Comment')}
        </button>
        
        <div className="jp-CommentSystem-search">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={trans.__('Search comments...')}
            className="jp-CommentSystem-search-input"
            aria-label={trans.__('Search through comments')}
          />
          {searchTerm && (
            <button
              onClick={() => setSearchTerm('')}
              className="jp-CommentSystem-search-clear"
              aria-label={trans.__('Clear search')}
            >
              ×
            </button>
          )}
        </div>
        
        <div className="jp-CommentSystem-filters">
          <label className="jp-CommentSystem-filter">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => setShowResolved(e.target.checked)}
              aria-describedby="show-resolved-help"
            />
            {trans.__('Show resolved')}
          </label>
          <div id="show-resolved-help" className="jp-CommentSystem-help-text">
            {trans.__('Include resolved comment threads in the list')}
          </div>
        </div>
      </div>

      <div 
        className="jp-CommentSystem-threads"
        role="region"
        aria-labelledby="comments-heading"
        aria-live="polite"
      >
        {filteredThreads.length === 0 ? (
          <div className="jp-CommentSystem-empty" role="status">
            {threads.length === 0 ? (
              <p>{trans.__('No comments yet. Create a comment to start a discussion.')}</p>
            ) : searchTerm ? (
              <p>{trans.__('No comments match the search term "%1".', searchTerm)}</p>
            ) : (
              <p>{trans.__('No comments match the current filter.')}</p>
            )}
          </div>
        ) : (
          <>
            <div className="jp-CommentSystem-threads-count" aria-live="polite">
              {trans.__('Showing %1 of %2 comment threads', filteredThreads.length, threads.length)}
            </div>
            {filteredThreads.map(thread => (
              <CommentThread
                key={thread.id}
                thread={thread}
                commentService={commentService}
                translator={translator}
                isActive={activeThread?.id === thread.id}
                onThreadClick={handleThreadClick}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
};

/**
 * A namespace for CommentSystemComponent statics.
 */
export namespace CommentSystemComponent {
  /**
   * Create a new CommentSystemComponent
   *
   * @param options - The component creation options
   */
  export const create = ({
    commentService,
    tracker,
    translator
  }: {
    commentService: ICommentService;
    tracker: INotebookTracker;
    translator: ITranslator;
  }): ReactWidget => {
    const widget = ReactWidget.create(
      <CommentSystemPanel 
        commentService={commentService}
        notebookTracker={tracker}
        translator={translator}
      />
    );
    
    widget.addClass('jp-CommentSystem-widget');
    widget.title.label = translator.load('notebook').__('Comments');
    widget.title.icon = 'jp-CommentIcon';
    widget.title.closable = true;

    // Add basic styling for the comment system
    const styleElement = document.createElement('style');
    styleElement.textContent = `
      .jp-CommentSystem {
        padding: 16px;
        background: var(--jp-layout-color1);
        color: var(--jp-ui-font-color1);
        font-family: var(--jp-ui-font-family);
        font-size: var(--jp-ui-font-size1);
        height: 100%;
        overflow-y: auto;
      }

      .jp-CommentSystem-header {
        border-bottom: 1px solid var(--jp-border-color2);
        padding-bottom: 8px;
        margin-bottom: 16px;
      }

      .jp-CommentSystem-title {
        margin: 0 0 8px 0;
        font-size: var(--jp-ui-font-size2);
        font-weight: 600;
      }

      .jp-CommentSystem-stats {
        display: flex;
        gap: 16px;
        font-size: var(--jp-ui-font-size0);
        color: var(--jp-ui-font-color2);
      }

      .jp-CommentSystem-error {
        background: var(--jp-error-color3);
        color: var(--jp-error-color1);
        padding: 8px 12px;
        border-radius: 4px;
        margin-bottom: 16px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .jp-CommentSystem-error-dismiss {
        background: none;
        border: none;
        color: inherit;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
      }

      .jp-CommentSystem-controls {
        margin-bottom: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .jp-CommentSystem-search {
        position: relative;
      }

      .jp-CommentSystem-search-input {
        width: 100%;
        padding: 8px 32px 8px 12px;
        border: 1px solid var(--jp-border-color2);
        border-radius: 4px;
        background: var(--jp-layout-color1);
        color: var(--jp-ui-font-color1);
      }

      .jp-CommentSystem-search-clear {
        position: absolute;
        right: 8px;
        top: 50%;
        transform: translateY(-50%);
        background: none;
        border: none;
        cursor: pointer;
        font-size: 16px;
        color: var(--jp-ui-font-color2);
      }

      .jp-CommentSystem-button {
        padding: 8px 16px;
        border: 1px solid var(--jp-border-color2);
        border-radius: 4px;
        cursor: pointer;
        font-family: inherit;
        font-size: inherit;
      }

      .jp-CommentSystem-button-primary {
        background: var(--jp-brand-color1);
        color: var(--jp-ui-inverse-font-color1);
        border-color: var(--jp-brand-color1);
      }

      .jp-CommentSystem-button-secondary {
        background: var(--jp-layout-color1);
        color: var(--jp-ui-font-color1);
      }

      .jp-CommentSystem-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .jp-CommentSystem-thread {
        border: 1px solid var(--jp-border-color2);
        border-radius: 4px;
        margin-bottom: 12px;
        background: var(--jp-layout-color0);
      }

      .jp-CommentSystem-thread-active {
        border-color: var(--jp-brand-color1);
        box-shadow: 0 0 0 1px var(--jp-brand-color1);
      }

      .jp-CommentSystem-thread-resolved {
        opacity: 0.7;
      }

      .jp-CommentSystem-thread-header {
        padding: 12px;
        cursor: pointer;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid var(--jp-border-color2);
      }

      .jp-CommentSystem-thread-actions {
        display: flex;
        gap: 8px;
      }

      .jp-CommentSystem-comment {
        padding: 12px;
        border-bottom: 1px solid var(--jp-border-color3);
      }

      .jp-CommentSystem-comment:last-child {
        border-bottom: none;
      }

      .jp-CommentSystem-comment-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }

      .jp-CommentSystem-comment-author {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .jp-CommentSystem-comment-avatar {
        border-radius: 50%;
      }

      .jp-CommentSystem-comment-edit-textarea,
      .jp-CommentSystem-reply-textarea,
      .jp-CommentSystem-new-comment-textarea {
        width: 100%;
        padding: 8px;
        border: 1px solid var(--jp-border-color2);
        border-radius: 4px;
        resize: vertical;
        font-family: inherit;
        background: var(--jp-layout-color1);
        color: var(--jp-ui-font-color1);
      }

      .jp-CommentSystem-keyboard-hint {
        font-size: var(--jp-ui-font-size0);
        color: var(--jp-ui-font-color2);
        margin-top: 4px;
      }

      .jp-CommentSystem-empty {
        text-align: center;
        padding: 32px;
        color: var(--jp-ui-font-color2);
      }

      .jp-CommentSystem-help-text {
        font-size: var(--jp-ui-font-size0);
        color: var(--jp-ui-font-color2);
        margin-top: 4px;
      }
    `;
    
    if (!document.head.querySelector('style[data-comment-system]')) {
      styleElement.setAttribute('data-comment-system', 'true');
      document.head.appendChild(styleElement);
    }

    return widget;
  };
}

/**
 * CSS class names for styling
 */
export namespace CommentSystemCSSClasses {
  export const root = 'jp-CommentSystem';
  export const widget = 'jp-CommentSystem-widget';
  export const header = 'jp-CommentSystem-header';
  export const title = 'jp-CommentSystem-title';
  export const stats = 'jp-CommentSystem-stats';
  export const stat = 'jp-CommentSystem-stat';
  export const controls = 'jp-CommentSystem-controls';
  export const filters = 'jp-CommentSystem-filters';
  export const filter = 'jp-CommentSystem-filter';
  export const threads = 'jp-CommentSystem-threads';
  export const thread = 'jp-CommentSystem-thread';
  export const threadActive = 'jp-CommentSystem-thread-active';
  export const threadResolved = 'jp-CommentSystem-thread-resolved';
  export const threadHeader = 'jp-CommentSystem-thread-header';
  export const threadInfo = 'jp-CommentSystem-thread-info';
  export const threadCount = 'jp-CommentSystem-thread-count';
  export const threadActions = 'jp-CommentSystem-thread-actions';
  export const threadResolve = 'jp-CommentSystem-thread-resolve';
  export const threadExpand = 'jp-CommentSystem-thread-expand';
  export const threadContent = 'jp-CommentSystem-thread-content';
  export const comment = 'jp-CommentSystem-comment';
  export const commentHeader = 'jp-CommentSystem-comment-header';
  export const commentAuthor = 'jp-CommentSystem-comment-author';
  export const commentAvatar = 'jp-CommentSystem-comment-avatar';
  export const commentTimestamp = 'jp-CommentSystem-comment-timestamp';
  export const commentActions = 'jp-CommentSystem-comment-actions';
  export const commentAction = 'jp-CommentSystem-comment-action';
  export const commentContent = 'jp-CommentSystem-comment-content';
  export const commentText = 'jp-CommentSystem-comment-text';
  export const reactions = 'jp-CommentSystem-comment-reactions';
  export const reaction = 'jp-CommentSystem-reaction';
  export const reactionAdd = 'jp-CommentSystem-reaction-add';
  export const button = 'jp-CommentSystem-button';
  export const buttonPrimary = 'jp-CommentSystem-button-primary';
  export const buttonSecondary = 'jp-CommentSystem-button-secondary';
  export const empty = 'jp-CommentSystem-empty';
}