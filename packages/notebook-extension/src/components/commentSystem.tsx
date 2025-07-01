import { ReactWidget } from '@jupyterlab/apputils';
import { Notebook, NotebookPanel } from '@jupyterlab/notebook';
import { ITranslator } from '@jupyterlab/translation';
import { Cell } from '@jupyterlab/cells';
import { CodeMirrorEditor } from '@jupyterlab/codemirror';
import { ISessionContext } from '@jupyterlab/apputils';

import React, { useEffect, useState, useCallback, useMemo } from 'react';

/**
 * Comment interface representing a single comment in a thread
 */
export interface IComment {
  /** Unique identifier for the comment */
  id: string;
  /** Cell ID that this comment is anchored to */
  cellId: string;
  /** Author information */
  author: {
    /** User identifier */
    id: string;
    /** Display name */
    name: string;
    /** User avatar URL or email for Gravatar */
    avatar?: string;
  };
  /** Comment content in markdown format */
  content: string;
  /** Timestamp when comment was created */
  createdAt: Date;
  /** Timestamp when comment was last modified */
  modifiedAt?: Date;
  /** Parent comment ID for threaded replies */
  parentId?: string;
  /** Whether this comment thread is resolved */
  resolved?: boolean;
  /** User who resolved the comment */
  resolvedBy?: string;
  /** Timestamp when comment was resolved */
  resolvedAt?: Date;
  /** Comment metadata for collaboration features */
  metadata?: Record<string, any>;
}

/**
 * Comment thread interface containing multiple related comments
 */
export interface ICommentThread {
  /** Root comment ID */
  id: string;
  /** Cell ID that this thread is anchored to */
  cellId: string;
  /** All comments in the thread (root + replies) */
  comments: IComment[];
  /** Whether the entire thread is resolved */
  resolved: boolean;
  /** Number of unread comments for current user */
  unreadCount?: number;
  /** Thread metadata */
  metadata?: Record<string, any>;
}

/**
 * Comment service interface for managing cell-level discussions
 */
export interface ICommentService {
  /** Get all comment threads for a specific cell */
  getThreadsForCell(cellId: string): Promise<ICommentThread[]>;
  
  /** Get all comment threads for the entire notebook */
  getAllThreads(): Promise<ICommentThread[]>;
  
  /** Create a new comment thread */
  createThread(cellId: string, content: string): Promise<ICommentThread>;
  
  /** Add a reply to an existing thread */
  addReply(threadId: string, content: string, parentId?: string): Promise<IComment>;
  
  /** Resolve or unresolve a comment thread */
  resolveThread(threadId: string, resolved: boolean): Promise<void>;
  
  /** Update an existing comment */
  updateComment(commentId: string, content: string): Promise<IComment>;
  
  /** Delete a comment */
  deleteComment(commentId: string): Promise<void>;
  
  /** Subscribe to comment changes */
  subscribe(callback: (threads: ICommentThread[]) => void): void;
  
  /** Unsubscribe from comment changes */
  unsubscribe(callback: (threads: ICommentThread[]) => void): void;
  
  /** Mark comments as read for current user */
  markAsRead(commentIds: string[]): Promise<void>;
}

/**
 * Props for the CommentPin component
 */
interface ICommentPinProps {
  /** Cell ID this pin represents */
  cellId: string;
  /** Number of comment threads for this cell */
  threadCount: number;
  /** Number of unread comments */
  unreadCount: number;
  /** Whether any thread is unresolved */
  hasUnresolved: boolean;
  /** Click handler to open comment sidebar */
  onClick: () => void;
}

/**
 * Comment pin component (📌) that displays in cell margins
 */
const CommentPin: React.FC<ICommentPinProps> = ({
  cellId,
  threadCount,
  unreadCount,
  hasUnresolved,
  onClick
}) => {
  const pinClass = useMemo(() => {
    const classes = ['jp-CommentPin'];
    if (unreadCount > 0) classes.push('jp-CommentPin-unread');
    if (hasUnresolved) classes.push('jp-CommentPin-unresolved');
    return classes.join(' ');
  }, [unreadCount, hasUnresolved]);

  const title = useMemo(() => {
    let parts = [`${threadCount} comment${threadCount !== 1 ? 's' : ''}`];
    if (unreadCount > 0) {
      parts.push(`${unreadCount} unread`);
    }
    if (hasUnresolved) {
      parts.push('has unresolved discussions');
    }
    return parts.join(', ');
  }, [threadCount, unreadCount, hasUnresolved]);

  return (
    <button
      className={pinClass}
      title={title}
      onClick={onClick}
      data-cell-id={cellId}
    >
      📌
      {threadCount > 0 && (
        <span className="jp-CommentPin-count">{threadCount}</span>
      )}
      {unreadCount > 0 && (
        <span className="jp-CommentPin-unread-indicator">{unreadCount}</span>
      )}
    </button>
  );
};

/**
 * Props for individual comment component
 */
interface ICommentItemProps {
  /** Comment data */
  comment: IComment;
  /** Whether this is a reply to another comment */
  isReply?: boolean;
  /** Whether editing is allowed */
  canEdit?: boolean;
  /** Whether user can resolve threads */
  canResolve?: boolean;
  /** Reply handler */
  onReply?: (parentId: string) => void;
  /** Edit handler */
  onEdit?: (commentId: string, content: string) => void;
  /** Delete handler */
  onDelete?: (commentId: string) => void;
  /** Resolve handler */
  onResolve?: (commentId: string) => void;
  /** Translation service */
  translator: ITranslator;
}

/**
 * Individual comment item component
 */
const CommentItem: React.FC<ICommentItemProps> = ({
  comment,
  isReply = false,
  canEdit = true,
  canResolve = true,
  onReply,
  onEdit,
  onDelete,
  onResolve,
  translator
}) => {
  const trans = translator.load('notebook');
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(comment.content);

  const handleEditSave = useCallback(() => {
    if (onEdit && editContent.trim() !== comment.content.trim()) {
      onEdit(comment.id, editContent.trim());
    }
    setIsEditing(false);
  }, [comment.id, comment.content, editContent, onEdit]);

  const handleEditCancel = useCallback(() => {
    setEditContent(comment.content);
    setIsEditing(false);
  }, [comment.content]);

  const formatDate = useCallback((date: Date) => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return trans.__('Just now');
    if (diffMins < 60) return trans.__('%1 minutes ago', diffMins);
    if (diffHours < 24) return trans.__('%1 hours ago', diffHours);
    if (diffDays < 7) return trans.__('%1 days ago', diffDays);
    return date.toLocaleDateString();
  }, [trans]);

  return (
    <div className={`jp-CommentItem ${isReply ? 'jp-CommentItem-reply' : ''}`}>
      <div className="jp-CommentItem-header">
        <div className="jp-CommentItem-author">
          {comment.author.avatar && (
            <img
              src={comment.author.avatar}
              alt={comment.author.name}
              className="jp-CommentItem-avatar"
            />
          )}
          <span className="jp-CommentItem-name">{comment.author.name}</span>
        </div>
        <div className="jp-CommentItem-meta">
          <span className="jp-CommentItem-date">
            {formatDate(comment.createdAt)}
          </span>
          {comment.modifiedAt && comment.modifiedAt > comment.createdAt && (
            <span className="jp-CommentItem-edited">
              {trans.__('(edited)')}
            </span>
          )}
          {comment.resolved && (
            <span className="jp-CommentItem-resolved">
              {trans.__('Resolved')}
            </span>
          )}
        </div>
      </div>

      <div className="jp-CommentItem-content">
        {isEditing ? (
          <div className="jp-CommentItem-edit">
            <textarea
              className="jp-CommentItem-textarea"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              placeholder={trans.__('Edit your comment...')}
              rows={3}
            />
            <div className="jp-CommentItem-edit-actions">
              <button
                className="jp-Button jp-Button-primary"
                onClick={handleEditSave}
                disabled={!editContent.trim()}
              >
                {trans.__('Save')}
              </button>
              <button
                className="jp-Button"
                onClick={handleEditCancel}
              >
                {trans.__('Cancel')}
              </button>
            </div>
          </div>
        ) : (
          <div
            className="jp-CommentItem-text"
            dangerouslySetInnerHTML={{
              __html: comment.content.replace(/\n/g, '<br>')
            }}
          />
        )}
      </div>

      <div className="jp-CommentItem-actions">
        {!isReply && onReply && (
          <button
            className="jp-CommentItem-action"
            onClick={() => onReply(comment.id)}
          >
            {trans.__('Reply')}
          </button>
        )}
        {canEdit && !isEditing && (
          <button
            className="jp-CommentItem-action"
            onClick={() => setIsEditing(true)}
          >
            {trans.__('Edit')}
          </button>
        )}
        {canResolve && !isReply && !comment.resolved && onResolve && (
          <button
            className="jp-CommentItem-action"
            onClick={() => onResolve(comment.id)}
          >
            {trans.__('Resolve')}
          </button>
        )}
        {canEdit && onDelete && (
          <button
            className="jp-CommentItem-action jp-CommentItem-action-delete"
            onClick={() => {
              if (confirm(trans.__('Are you sure you want to delete this comment?'))) {
                onDelete(comment.id);
              }
            }}
          >
            {trans.__('Delete')}
          </button>
        )}
      </div>
    </div>
  );
};

/**
 * Props for comment thread component
 */
interface ICommentThreadProps {
  /** Thread data */
  thread: ICommentThread;
  /** Whether thread is expanded */
  expanded?: boolean;
  /** Expansion toggle handler */
  onToggleExpand?: (threadId: string) => void;
  /** Reply handler */
  onReply?: (threadId: string, content: string, parentId?: string) => void;
  /** Edit handler */
  onEdit?: (commentId: string, content: string) => void;
  /** Delete handler */
  onDelete?: (commentId: string) => void;
  /** Resolve handler */
  onResolve?: (threadId: string, resolved: boolean) => void;
  /** Translation service */
  translator: ITranslator;
}

/**
 * Comment thread component containing root comment and replies
 */
const CommentThread: React.FC<ICommentThreadProps> = ({
  thread,
  expanded = true,
  onToggleExpand,
  onReply,
  onEdit,
  onDelete,
  onResolve,
  translator
}) => {
  const trans = translator.load('notebook');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState('');

  const rootComment = useMemo(
    () => thread.comments.find(c => !c.parentId),
    [thread.comments]
  );

  const replies = useMemo(
    () => thread.comments.filter(c => c.parentId).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    ),
    [thread.comments]
  );

  const handleReply = useCallback((parentId: string) => {
    setReplyingTo(parentId);
    setReplyContent('');
  }, []);

  const handleSubmitReply = useCallback(() => {
    if (onReply && replyContent.trim() && replyingTo) {
      onReply(thread.id, replyContent.trim(), replyingTo);
      setReplyingTo(null);
      setReplyContent('');
    }
  }, [thread.id, replyContent, replyingTo, onReply]);

  const handleCancelReply = useCallback(() => {
    setReplyingTo(null);
    setReplyContent('');
  }, []);

  const handleResolveToggle = useCallback(() => {
    if (onResolve) {
      onResolve(thread.id, !thread.resolved);
    }
  }, [thread.id, thread.resolved, onResolve]);

  if (!rootComment) {
    return null;
  }

  return (
    <div className={`jp-CommentThread ${thread.resolved ? 'jp-CommentThread-resolved' : ''}`}>
      <div className="jp-CommentThread-header">
        <button
          className="jp-CommentThread-toggle"
          onClick={() => onToggleExpand?.(thread.id)}
          title={expanded ? trans.__('Collapse thread') : trans.__('Expand thread')}
        >
          {expanded ? '[-]' : '[+]'}
        </button>
        <span className="jp-CommentThread-title">
          {trans.__('Cell #%1 - %2', 
            thread.cellId.slice(-6), 
            rootComment.cellId === 'markdown' ? 'Markdown Cell' : 'Code Cell'
          )}
        </span>
        {onResolve && (
          <button
            className={`jp-CommentThread-resolve ${thread.resolved ? 'jp-CommentThread-resolved' : ''}`}
            onClick={handleResolveToggle}
            title={thread.resolved ? trans.__('Unresolve thread') : trans.__('Resolve thread')}
          >
            {thread.resolved ? trans.__('[Resolved]') : trans.__('[Resolve]')}
          </button>
        )}
      </div>

      {expanded && (
        <div className="jp-CommentThread-content">
          <CommentItem
            comment={rootComment}
            canEdit={true}
            canResolve={false}
            onReply={handleReply}
            onEdit={onEdit}
            onDelete={onDelete}
            translator={translator}
          />

          {replies.map(reply => (
            <CommentItem
              key={reply.id}
              comment={reply}
              isReply={true}
              canEdit={true}
              canResolve={false}
              onEdit={onEdit}
              onDelete={onDelete}
              translator={translator}
            />
          ))}

          {replyingTo && (
            <div className="jp-CommentReply">
              <textarea
                className="jp-CommentReply-textarea"
                value={replyContent}
                onChange={(e) => setReplyContent(e.target.value)}
                placeholder={trans.__('Add a reply...')}
                rows={3}
              />
              <div className="jp-CommentReply-actions">
                <button
                  className="jp-Button jp-Button-primary"
                  onClick={handleSubmitReply}
                  disabled={!replyContent.trim()}
                >
                  {trans.__('Reply')}
                </button>
                <button
                  className="jp-Button"
                  onClick={handleCancelReply}
                >
                  {trans.__('Cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Props for the main comment sidebar component
 */
interface ICommentSidebarProps {
  /** Notebook panel instance */
  notebookPanel: NotebookPanel;
  /** Comment service */
  commentService: ICommentService;
  /** Translation service */
  translator: ITranslator;
}

/**
 * Main comment sidebar component
 */
const CommentSidebar: React.FC<ICommentSidebarProps> = ({
  notebookPanel,
  commentService,
  translator
}) => {
  const trans = translator.load('notebook');
  const [threads, setThreads] = useState<ICommentThread[]>([]);
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null);
  const [newCommentContent, setNewCommentContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Subscribe to comment changes
  useEffect(() => {
    const handleThreadsUpdate = (updatedThreads: ICommentThread[]) => {
      setThreads(updatedThreads);
    };

    commentService.subscribe(handleThreadsUpdate);
    
    // Initial load
    commentService.getAllThreads().then(setThreads);

    return () => {
      commentService.unsubscribe(handleThreadsUpdate);
    };
  }, [commentService]);

  // Track active cell selection
  useEffect(() => {
    const notebook = notebookPanel.content;
    
    const handleActiveCellChanged = () => {
      const activeCell = notebook.activeCell;
      if (activeCell) {
        setSelectedCellId(activeCell.model.id);
      }
    };

    notebook.activeCellChanged.connect(handleActiveCellChanged);
    
    // Set initial active cell
    if (notebook.activeCell) {
      setSelectedCellId(notebook.activeCell.model.id);
    }

    return () => {
      notebook.activeCellChanged.disconnect(handleActiveCellChanged);
    };
  }, [notebookPanel]);

  const handleCreateComment = useCallback(async () => {
    if (!selectedCellId || !newCommentContent.trim()) {
      return;
    }

    setIsLoading(true);
    try {
      await commentService.createThread(selectedCellId, newCommentContent.trim());
      setNewCommentContent('');
    } catch (error) {
      console.error('Failed to create comment:', error);
    } finally {
      setIsLoading(false);
    }
  }, [selectedCellId, newCommentContent, commentService]);

  const handleToggleExpand = useCallback((threadId: string) => {
    setExpandedThreads(prev => {
      const next = new Set(prev);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  }, []);

  const handleReply = useCallback(async (threadId: string, content: string, parentId?: string) => {
    try {
      await commentService.addReply(threadId, content, parentId);
    } catch (error) {
      console.error('Failed to add reply:', error);
    }
  }, [commentService]);

  const handleEdit = useCallback(async (commentId: string, content: string) => {
    try {
      await commentService.updateComment(commentId, content);
    } catch (error) {
      console.error('Failed to edit comment:', error);
    }
  }, [commentService]);

  const handleDelete = useCallback(async (commentId: string) => {
    try {
      await commentService.deleteComment(commentId);
    } catch (error) {
      console.error('Failed to delete comment:', error);
    }
  }, [commentService]);

  const handleResolve = useCallback(async (threadId: string, resolved: boolean) => {
    try {
      await commentService.resolveThread(threadId, resolved);
    } catch (error) {
      console.error('Failed to resolve thread:', error);
    }
  }, [commentService]);

  const handleRefresh = useCallback(async () => {
    try {
      const updatedThreads = await commentService.getAllThreads();
      setThreads(updatedThreads);
    } catch (error) {
      console.error('Failed to refresh comments:', error);
    }
  }, [commentService]);

  const filteredThreads = useMemo(
    () => threads.sort((a, b) => {
      // Sort by cell order, then by creation time
      return a.cellId.localeCompare(b.cellId) || 
             (a.comments[0]?.createdAt.getTime() || 0) - (b.comments[0]?.createdAt.getTime() || 0);
    }),
    [threads]
  );

  return (
    <div className="jp-CommentSidebar">
      <div className="jp-CommentSidebar-header">
        <span className="jp-CommentSidebar-title">
          {trans.__('Comments: %1', notebookPanel.context.localPath)}
        </span>
        <div className="jp-CommentSidebar-actions">
          <button
            className="jp-CommentSidebar-refresh"
            onClick={handleRefresh}
            title={trans.__('Refresh comments')}
          >
            ⟳
          </button>
          <button
            className="jp-CommentSidebar-close"
            onClick={() => {
              // Close sidebar logic would be handled by parent component
            }}
            title={trans.__('Close comments')}
          >
            ×
          </button>
        </div>
      </div>

      <div className="jp-CommentSidebar-content">
        {filteredThreads.map(thread => (
          <CommentThread
            key={thread.id}
            thread={thread}
            expanded={expandedThreads.has(thread.id)}
            onToggleExpand={handleToggleExpand}
            onReply={handleReply}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onResolve={handleResolve}
            translator={translator}
          />
        ))}

        {filteredThreads.length === 0 && (
          <div className="jp-CommentSidebar-empty">
            {trans.__('No comments yet. Select a cell and add the first comment!')}
          </div>
        )}
      </div>

      <div className="jp-CommentSidebar-footer">
        <div className="jp-CommentNew">
          <textarea
            className="jp-CommentNew-textarea"
            value={newCommentContent}
            onChange={(e) => setNewCommentContent(e.target.value)}
            placeholder={selectedCellId 
              ? trans.__('Add a comment to the selected cell...')
              : trans.__('Select a cell to add a comment...')
            }
            disabled={!selectedCellId || isLoading}
            rows={3}
          />
          <div className="jp-CommentNew-actions">
            <button
              className="jp-Button jp-Button-primary"
              onClick={handleCreateComment}
              disabled={!selectedCellId || !newCommentContent.trim() || isLoading}
            >
              {isLoading ? trans.__('Adding...') : trans.__('Add Comment')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Props for the comment pins manager component
 */
interface ICommentPinsManagerProps {
  /** Notebook panel instance */
  notebookPanel: NotebookPanel;
  /** Comment service */
  commentService: ICommentService;
  /** Handler for opening comment sidebar */
  onOpenSidebar: (cellId: string) => void;
}

/**
 * Manager component for comment pins in cell margins
 */
const CommentPinsManager: React.FC<ICommentPinsManagerProps> = ({
  notebookPanel,
  commentService,
  onOpenSidebar
}) => {
  const [threads, setThreads] = useState<ICommentThread[]>([]);

  useEffect(() => {
    const handleThreadsUpdate = (updatedThreads: ICommentThread[]) => {
      setThreads(updatedThreads);
    };

    commentService.subscribe(handleThreadsUpdate);
    commentService.getAllThreads().then(setThreads);

    return () => {
      commentService.unsubscribe(handleThreadsUpdate);
    };
  }, [commentService]);

  // Render comment pins in cell margins
  useEffect(() => {
    const notebook = notebookPanel.content;
    
    // Clear existing pins
    const existingPins = notebook.node.querySelectorAll('.jp-CommentPin');
    existingPins.forEach(pin => pin.remove());

    // Add new pins
    threads.forEach(thread => {
      const cell = notebook.widgets.find(widget => widget.model.id === thread.cellId);
      if (cell) {
        const cellNode = cell.node;
        const inputArea = cellNode.querySelector('.jp-Cell-inputArea');
        
        if (inputArea) {
          const pinContainer = document.createElement('div');
          pinContainer.className = 'jp-CommentPin-container';
          
          const threadCount = thread.comments.length;
          const unreadCount = thread.unreadCount || 0;
          const hasUnresolved = !thread.resolved;

          // Create React component and render
          const pin = React.createElement(CommentPin, {
            cellId: thread.cellId,
            threadCount,
            unreadCount,
            hasUnresolved,
            onClick: () => onOpenSidebar(thread.cellId)
          });

          // Use ReactDOM to render the pin
          import('@jupyterlab/apputils').then(({ ReactWidget }) => {
            const widget = ReactWidget.create(pin);
            pinContainer.appendChild(widget.node);
          });

          inputArea.insertBefore(pinContainer, inputArea.firstChild);
        }
      }
    });
  }, [threads, notebookPanel, onOpenSidebar]);

  return null; // This component only manages DOM side effects
};

/**
 * Main comment system component integrating sidebar and pins
 */
export const CommentSystem = ({
  notebookPanel,
  commentService,
  translator
}: {
  notebookPanel: NotebookPanel;
  commentService: ICommentService;
  translator: ITranslator;
}): JSX.Element => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null);

  const handleOpenSidebar = useCallback((cellId: string) => {
    setSelectedCellId(cellId);
    setSidebarOpen(true);
  }, []);

  const handleCloseSidebar = useCallback(() => {
    setSidebarOpen(false);
    setSelectedCellId(null);
  }, []);

  return (
    <div className="jp-CommentSystem">
      <CommentPinsManager
        notebookPanel={notebookPanel}
        commentService={commentService}
        onOpenSidebar={handleOpenSidebar}
      />
      
      {sidebarOpen && (
        <div className="jp-CommentSystem-sidebar">
          <CommentSidebar
            notebookPanel={notebookPanel}
            commentService={commentService}
            translator={translator}
          />
        </div>
      )}
    </div>
  );
};

/**
 * A namespace for CommentSystem static methods.
 */
export namespace CommentSystemComponent {
  /**
   * Create a new CommentSystem widget
   *
   * @param notebookPanel The notebook panel
   * @param commentService The comment service
   * @param translator The translator
   */
  export const create = ({
    notebookPanel,
    commentService,
    translator,
  }: {
    notebookPanel: NotebookPanel;
    commentService: ICommentService;
    translator: ITranslator;
  }): ReactWidget => {
    return ReactWidget.create(
      <CommentSystem
        notebookPanel={notebookPanel}
        commentService={commentService}
        translator={translator}
      />
    );
  };
}