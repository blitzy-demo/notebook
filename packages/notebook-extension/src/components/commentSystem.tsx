// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

/**
 * Comment and review system for collaborative notebooks
 * 
 * This component allows users to create, view, reply to, and resolve comments
 * attached to specific cells or text selections. It integrates with the
 * ICommentService to store and synchronize comments across all clients.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { NotebookPanel, INotebookTracker } from '@jupyterlab/notebook';
import { ICellModel } from '@jupyterlab/cells';
import { UUID } from '@lumino/coreutils';
import { Widget } from '@lumino/widgets';
import { IDisposable } from '@lumino/disposable';

import {
  ICommentService,
  ICommentThread,
  IComment,
  ICommentReply,
  ICommentUser,
  ICommentRange,
  CommentStatus,
  CommentPriority,
  ICommentFilter,
  ICommentChangeEvent,
  CommentChangeType
} from '../../notebook/src/collab/comments';

/**
 * Props for the CommentSystem component
 */
interface ICommentSystemProps {
  /**
   * The notebook panel containing the notebook
   */
  notebookPanel: NotebookPanel;

  /**
   * The comment service for managing comments
   */
  commentService: ICommentService;

  /**
   * The translator for internationalization
   */
  translator?: ITranslator;

  /**
   * The current user information
   */
  currentUser: ICommentUser;
}

/**
 * Props for the CommentBadge component
 */
interface ICommentBadgeProps {
  /**
   * The thread associated with this badge
   */
  thread: ICommentThread;

  /**
   * Callback when the badge is clicked
   */
  onClick: () => void;

  /**
   * Whether the thread is selected
   */
  isSelected: boolean;

  /**
   * The top position of the badge
   */
  top: number;
}

/**
 * Props for the CommentThread component
 */
interface ICommentThreadProps {
  /**
   * The thread to display
   */
  thread: ICommentThread;

  /**
   * The comment service for managing comments
   */
  commentService: ICommentService;

  /**
   * The current user information
   */
  currentUser: ICommentUser;

  /**
   * Callback when the thread should be closed
   */
  onClose: () => void;

  /**
   * The translator for internationalization
   */
  translator: ITranslator;

  /**
   * The position of the thread
   */
  position: { top: number; left: number };
}

/**
 * Props for the Comment component
 */
interface ICommentProps {
  /**
   * The comment to display
   */
  comment: IComment;

  /**
   * The thread ID containing this comment
   */
  threadId: string;

  /**
   * The comment service for managing comments
   */
  commentService: ICommentService;

  /**
   * The current user information
   */
  currentUser: ICommentUser;

  /**
   * The translator for internationalization
   */
  translator: ITranslator;
}

/**
 * Props for the CommentReply component
 */
interface ICommentReplyProps {
  /**
   * The reply to display
   */
  reply: ICommentReply;

  /**
   * The thread ID containing this reply
   */
  threadId: string;

  /**
   * The comment ID containing this reply
   */
  commentId: string;

  /**
   * The comment service for managing comments
   */
  commentService: ICommentService;

  /**
   * The current user information
   */
  currentUser: ICommentUser;

  /**
   * The translator for internationalization
   */
  translator: ITranslator;
}

/**
 * Props for the CommentInput component
 */
interface ICommentInputProps {
  /**
   * Callback when a comment is submitted
   */
  onSubmit: (content: string) => void;

  /**
   * Placeholder text for the input
   */
  placeholder?: string;

  /**
   * Initial value for the input
   */
  initialValue?: string;

  /**
   * The translator for internationalization
   */
  translator: ITranslator;

  /**
   * Button text
   */
  buttonText?: string;
}

/**
 * Props for the CommentPanel component
 */
interface ICommentPanelProps {
  /**
   * The comment service for managing comments
   */
  commentService: ICommentService;

  /**
   * The notebook panel containing the notebook
   */
  notebookPanel: NotebookPanel;

  /**
   * The current user information
   */
  currentUser: ICommentUser;

  /**
   * The translator for internationalization
   */
  translator: ITranslator;
}

/**
 * Format a timestamp as a relative time string
 */
function formatRelativeTime(timestamp: number, translator: ITranslator): string {
  const trans = translator.load('notebook');
  const now = Date.now();
  const diff = now - timestamp;
  
  // Less than a minute
  if (diff < 60000) {
    return trans.__('just now');
  }
  
  // Less than an hour
  if (diff < 3600000) {
    const minutes = Math.floor(diff / 60000);
    return minutes === 1 ? trans.__('1 minute ago') : trans.__('%1 minutes ago', minutes);
  }
  
  // Less than a day
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return hours === 1 ? trans.__('1 hour ago') : trans.__('%1 hours ago', hours);
  }
  
  // Less than a week
  if (diff < 604800000) {
    const days = Math.floor(diff / 86400000);
    return days === 1 ? trans.__('1 day ago') : trans.__('%1 days ago', days);
  }
  
  // Format as date
  const date = new Date(timestamp);
  return date.toLocaleDateString();
}

/**
 * Extract the first letter of a name for avatar display
 */
function getInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

/**
 * Get a color for a user based on their ID
 */
function getUserColor(userId: string): string {
  // Simple hash function to generate a consistent color for a user
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  // Generate HSL color with fixed saturation and lightness
  const hue = hash % 360;
  return `hsl(${hue}, 70%, 45%)`;
}

/**
 * Comment badge component that shows in the margin of cells
 */
function CommentBadge(props: ICommentBadgeProps): JSX.Element {
  const { thread, onClick, isSelected, top } = props;
  
  // Count unresolved comments
  const unresolvedCount = thread.comments.filter(
    comment => comment.status === CommentStatus.Open
  ).length;
  
  // Determine if all comments are resolved
  const allResolved = unresolvedCount === 0 && thread.comments.length > 0;
  
  return (
    <div 
      className={`jp-Comment-badge ${allResolved ? 'jp-mod-resolved' : 'jp-mod-unresolved'} ${isSelected ? 'jp-mod-selected' : ''}`}
      style={{ top: `${top}px` }}
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={allResolved ? 'Resolved comments' : 'Unresolved comments'}
    >
      {thread.comments.length}
    </div>
  );
}

/**
 * Comment input component for creating new comments or replies
 */
function CommentInput(props: ICommentInputProps): JSX.Element {
  const { onSubmit, placeholder, initialValue, translator, buttonText } = props;
  const trans = translator.load('notebook');
  const [content, setContent] = useState(initialValue || '');
  
  const handleSubmit = () => {
    if (content.trim()) {
      onSubmit(content);
      setContent('');
    }
  };
  
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Submit on Ctrl+Enter or Cmd+Enter
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };
  
  return (
    <div className="jp-CommentThread-input">
      <textarea
        className="jp-CommentThread-textarea"
        value={content}
        onChange={e => setContent(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder || trans.__('Add a comment...')}
      />
      <button 
        className="jp-CommentThread-submit"
        onClick={handleSubmit}
        disabled={!content.trim()}
      >
        {buttonText || trans.__('Comment')}
      </button>
    </div>
  );
}

/**
 * Comment reply component
 */
function CommentReply(props: ICommentReplyProps): JSX.Element {
  const { reply, threadId, commentId, commentService, currentUser, translator } = props;
  const trans = translator.load('notebook');
  const [isEditing, setIsEditing] = useState(false);
  
  const handleEdit = (content: string) => {
    commentService.updateReply(threadId, commentId, reply.id, content);
    setIsEditing(false);
  };
  
  const handleDelete = () => {
    if (window.confirm(trans.__('Are you sure you want to delete this reply?'))) {
      commentService.deleteReply(threadId, commentId, reply.id);
    }
  };
  
  // Check if the current user is the author of this reply
  const isAuthor = currentUser.id === reply.author.id;
  
  if (isEditing) {
    return (
      <div className="jp-Comment-reply-edit">
        <CommentInput
          onSubmit={handleEdit}
          initialValue={reply.content}
          translator={translator}
          buttonText={trans.__('Save')}
        />
        <button 
          className="jp-Comment-cancel"
          onClick={() => setIsEditing(false)}
        >
          {trans.__('Cancel')}
        </button>
      </div>
    );
  }
  
  return (
    <div className="jp-Comment-reply">
      <div className="jp-Comment-header">
        <div 
          className="jp-Comment-avatar"
          style={{ backgroundColor: getUserColor(reply.author.id) }}
        >
          {getInitial(reply.author.displayName)}
        </div>
        <div className="jp-Comment-username">{reply.author.displayName}</div>
        <div className="jp-Comment-timestamp">
          {formatRelativeTime(reply.createdAt, translator)}
          {reply.edited && ` (${trans.__('edited')})`}
        </div>
      </div>
      <div className="jp-Comment-content">{reply.content}</div>
      {isAuthor && (
        <div className="jp-Comment-footer">
          <button 
            className="jp-Comment-edit"
            onClick={() => setIsEditing(true)}
          >
            {trans.__('Edit')}
          </button>
          <button 
            className="jp-Comment-delete"
            onClick={handleDelete}
          >
            {trans.__('Delete')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Individual comment component
 */
function Comment(props: ICommentProps): JSX.Element {
  const { comment, threadId, commentService, currentUser, translator } = props;
  const trans = translator.load('notebook');
  const [isEditing, setIsEditing] = useState(false);
  const [isReplying, setIsReplying] = useState(false);
  
  const handleEdit = (content: string) => {
    commentService.updateComment(threadId, comment.id, content);
    setIsEditing(false);
  };
  
  const handleDelete = () => {
    if (window.confirm(trans.__('Are you sure you want to delete this comment?'))) {
      commentService.deleteComment(threadId, comment.id);
    }
  };
  
  const handleReply = (content: string) => {
    commentService.addReply(threadId, comment.id, content, currentUser);
    setIsReplying(false);
  };
  
  const handleResolve = () => {
    if (comment.status === CommentStatus.Open) {
      commentService.resolveComment(threadId, comment.id, currentUser);
    } else {
      commentService.reopenComment(threadId, comment.id);
    }
  };
  
  // Check if the current user is the author of this comment
  const isAuthor = currentUser.id === comment.author.id;
  
  if (isEditing) {
    return (
      <div className="jp-Comment">
        <CommentInput
          onSubmit={handleEdit}
          initialValue={comment.content}
          translator={translator}
          buttonText={trans.__('Save')}
        />
        <button 
          className="jp-Comment-cancel"
          onClick={() => setIsEditing(false)}
        >
          {trans.__('Cancel')}
        </button>
      </div>
    );
  }
  
  return (
    <div className="jp-Comment">
      <div className="jp-Comment-header">
        <div 
          className="jp-Comment-avatar"
          style={{ backgroundColor: getUserColor(comment.author.id) }}
        >
          {getInitial(comment.author.displayName)}
        </div>
        <div className="jp-Comment-username">{comment.author.displayName}</div>
        <div className="jp-Comment-timestamp">
          {formatRelativeTime(comment.createdAt, translator)}
          {comment.edited && ` (${trans.__('edited')})`}
        </div>
      </div>
      <div className="jp-Comment-content">{comment.content}</div>
      <div className="jp-Comment-footer">
        <label className="jp-Comment-resolve">
          <input 
            type="checkbox" 
            checked={comment.status === CommentStatus.Resolved}
            onChange={handleResolve}
          />
          {comment.status === CommentStatus.Resolved 
            ? trans.__('Resolved') 
            : trans.__('Resolve')}
        </label>
        <button 
          className="jp-Comment-reply"
          onClick={() => setIsReplying(!isReplying)}
        >
          {trans.__('Reply')}
        </button>
        {isAuthor && (
          <>
            <button 
              className="jp-Comment-edit"
              onClick={() => setIsEditing(true)}
            >
              {trans.__('Edit')}
            </button>
            <button 
              className="jp-Comment-delete"
              onClick={handleDelete}
            >
              {trans.__('Delete')}
            </button>
          </>
        )}
      </div>
      
      {/* Display replies */}
      {comment.replies.length > 0 && (
        <div className="jp-Comment-replies">
          {comment.replies.map(reply => (
            <CommentReply
              key={reply.id}
              reply={reply}
              threadId={threadId}
              commentId={comment.id}
              commentService={commentService}
              currentUser={currentUser}
              translator={translator}
            />
          ))}
        </div>
      )}
      
      {/* Reply input */}
      {isReplying && (
        <div className="jp-Comment-replyInput">
          <CommentInput
            onSubmit={handleReply}
            placeholder={trans.__('Write a reply...')}
            translator={translator}
            buttonText={trans.__('Reply')}
          />
          <button 
            className="jp-Comment-cancel"
            onClick={() => setIsReplying(false)}
          >
            {trans.__('Cancel')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Comment thread component
 */
function CommentThread(props: ICommentThreadProps): JSX.Element {
  const { thread, commentService, currentUser, onClose, translator, position } = props;
  const trans = translator.load('notebook');
  
  const handleAddComment = (content: string) => {
    commentService.addComment(thread.id, content, currentUser);
  };
  
  return (
    <div 
      className="jp-CommentThread"
      style={{ top: position.top, left: position.left }}
    >
      <div className="jp-CommentThread-header">
        <div className="jp-CommentThread-title">
          {trans.__('Comments')}
        </div>
        <div className="jp-CommentThread-actions">
          <button 
            className="jp-CommentThread-close"
            onClick={onClose}
            aria-label={trans.__('Close')}
          >
            ×
          </button>
        </div>
      </div>
      
      <div className="jp-CommentThread-comments">
        {thread.comments.map(comment => (
          <Comment
            key={comment.id}
            comment={comment}
            threadId={thread.id}
            commentService={commentService}
            currentUser={currentUser}
            translator={translator}
          />
        ))}
      </div>
      
      <CommentInput
        onSubmit={handleAddComment}
        translator={translator}
      />
    </div>
  );
}

/**
 * Comment panel component for the sidebar
 */
function CommentPanel(props: ICommentPanelProps): JSX.Element {
  const { commentService, notebookPanel, currentUser, translator } = props;
  const trans = translator.load('notebook');
  const [threads, setThreads] = useState<ICommentThread[]>([]);
  const [filter, setFilter] = useState<ICommentFilter>({});
  
  // Update threads when comments change
  useEffect(() => {
    const updateThreads = () => {
      setThreads(commentService.filterComments(filter));
    };
    
    // Initial load
    updateThreads();
    
    // Subscribe to changes
    const onChange = (event: ICommentChangeEvent) => {
      updateThreads();
    };
    
    commentService.changed.connect(onChange);
    
    return () => {
      commentService.changed.disconnect(onChange);
    };
  }, [commentService, filter]);
  
  const handleFilterChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    if (value === 'all') {
      setFilter({});
    } else if (value === 'open') {
      setFilter({ status: CommentStatus.Open });
    } else if (value === 'resolved') {
      setFilter({ status: CommentStatus.Resolved });
    } else if (value === 'mine') {
      setFilter({ authorId: currentUser.id });
    }
  };
  
  const handleThreadClick = (thread: ICommentThread) => {
    // Find the cell with this ID
    const notebook = notebookPanel.content;
    const cells = notebook.widgets;
    
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (cell.model.id === thread.cellId) {
        // Scroll to the cell
        notebook.scrollToCell(cell);
        
        // Activate the cell
        notebook.activeCellIndex = i;
        notebook.mode = 'edit';
        
        // Trigger a click on the comment badge
        const badge = document.querySelector(
          `.jp-Comment-badge[data-thread-id="${thread.id}"]`
        ) as HTMLElement;
        
        if (badge) {
          badge.click();
        }
        
        break;
      }
    }
  };
  
  return (
    <div className="jp-CommentPanel">
      <div className="jp-CommentPanel-header">
        <div className="jp-CommentPanel-title">
          {trans.__('Comments')}
        </div>
        <select 
          className="jp-CommentPanel-filter"
          onChange={handleFilterChange}
          aria-label={trans.__('Filter comments')}
        >
          <option value="all">{trans.__('All comments')}</option>
          <option value="open">{trans.__('Open comments')}</option>
          <option value="resolved">{trans.__('Resolved comments')}</option>
          <option value="mine">{trans.__('My comments')}</option>
        </select>
      </div>
      
      <div className="jp-CommentPanel-content">
        {threads.length > 0 ? (
          threads.map(thread => {
            // Get the first comment as preview
            const firstComment = thread.comments[0];
            if (!firstComment) return null;
            
            return (
              <div 
                key={thread.id}
                className="jp-CommentPanel-item"
                onClick={() => handleThreadClick(thread)}
              >
                <div className="jp-CommentPanel-itemHeader">
                  <div 
                    className="jp-Comment-avatar"
                    style={{ backgroundColor: getUserColor(firstComment.author.id) }}
                  >
                    {getInitial(firstComment.author.displayName)}
                  </div>
                  <div className="jp-Comment-username">
                    {firstComment.author.displayName}
                  </div>
                  <div className="jp-Comment-timestamp">
                    {formatRelativeTime(firstComment.createdAt, translator)}
                  </div>
                </div>
                <div className="jp-CommentPanel-itemCell">
                  {trans.__('Cell %1', thread.cellId.slice(0, 8))}
                </div>
                <div className="jp-CommentPanel-itemPreview">
                  {firstComment.content.length > 60
                    ? `${firstComment.content.slice(0, 60)}...`
                    : firstComment.content}
                </div>
              </div>
            );
          })
        ) : (
          <div className="jp-CommentPanel-empty">
            <div className="jp-CommentPanel-emptyIcon">💬</div>
            <div className="jp-CommentPanel-emptyText">
              {trans.__('No comments found')}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Main comment system component
 */
export function CommentSystem(props: ICommentSystemProps): JSX.Element {
  const { notebookPanel, commentService, currentUser } = props;
  const translator = props.translator || nullTranslator;
  const trans = translator.load('notebook');
  
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ICommentThread[]>([]);
  const [newThreadCell, setNewThreadCell] = useState<{ cellId: string; top: number } | null>(null);
  
  // Update threads when comments change
  useEffect(() => {
    const updateThreads = () => {
      setThreads(commentService.getThreads());
    };
    
    // Initial load
    updateThreads();
    
    // Subscribe to changes
    const onChange = (event: ICommentChangeEvent) => {
      updateThreads();
    };
    
    commentService.changed.connect(onChange);
    
    return () => {
      commentService.changed.disconnect(onChange);
    };
  }, [commentService]);
  
  // Handle cell context menu for adding comments
  useEffect(() => {
    const notebook = notebookPanel.content;
    
    // Add context menu handler to cells
    const handleContextMenu = (event: MouseEvent) => {
      // Find the cell element that was clicked
      let target = event.target as HTMLElement;
      let cellElement: HTMLElement | null = null;
      
      while (target && !cellElement) {
        if (target.classList.contains('jp-Cell')) {
          cellElement = target;
        }
        target = target.parentElement as HTMLElement;
      }
      
      if (!cellElement) return;
      
      // Get the cell ID
      const cellId = cellElement.getAttribute('data-cell-id');
      if (!cellId) return;
      
      // Add "Add Comment" option to context menu
      const menu = document.createElement('div');
      menu.className = 'jp-ContextMenu';
      menu.style.position = 'absolute';
      menu.style.left = `${event.pageX}px`;
      menu.style.top = `${event.pageY}px`;
      menu.style.zIndex = '1000';
      
      const addCommentOption = document.createElement('div');
      addCommentOption.className = 'jp-ContextMenu-item';
      addCommentOption.textContent = trans.__('Add Comment');
      addCommentOption.addEventListener('click', () => {
        // Create a new thread at this position
        setNewThreadCell({
          cellId,
          top: event.clientY - cellElement!.getBoundingClientRect().top
        });
        
        // Remove the context menu
        document.body.removeChild(menu);
      });
      
      menu.appendChild(addCommentOption);
      document.body.appendChild(menu);
      
      // Remove the menu when clicking outside
      const removeMenu = (e: MouseEvent) => {
        if (!menu.contains(e.target as Node)) {
          document.body.removeChild(menu);
          document.removeEventListener('click', removeMenu);
        }
      };
      
      // Prevent the first click from removing the menu
      setTimeout(() => {
        document.addEventListener('click', removeMenu);
      }, 0);
      
      // Prevent the default context menu
      event.preventDefault();
    };
    
    // Add cell IDs to cell elements for easier lookup
    const addCellIds = () => {
      notebook.widgets.forEach(cell => {
        const cellElement = cell.node;
        cellElement.setAttribute('data-cell-id', cell.model.id);
      });
    };
    
    // Initial setup
    addCellIds();
    
    // Update cell IDs when cells change
    const onModelChanged = () => {
      addCellIds();
    };
    
    notebook.model?.cells.changed.connect(onModelChanged);
    
    // Add context menu listener
    notebook.node.addEventListener('contextmenu', handleContextMenu);
    
    return () => {
      notebook.node.removeEventListener('contextmenu', handleContextMenu);
      notebook.model?.cells.changed.disconnect(onModelChanged);
      
      // Remove any open context menus
      const menus = document.querySelectorAll('.jp-ContextMenu');
      menus.forEach(menu => {
        if (document.body.contains(menu)) {
          document.body.removeChild(menu);
        }
      });
    };
  }, [notebookPanel, trans]);
  
  // Handle creating a new thread
  const handleCreateThread = (content: string) => {
    if (!newThreadCell) return;
    
    commentService.createThread(
      newThreadCell.cellId,
      content,
      currentUser
    );
    
    setNewThreadCell(null);
  };
  
  // Calculate positions for comment badges and threads
  const getThreadPosition = (thread: ICommentThread) => {
    const notebook = notebookPanel.content;
    const cells = notebook.widgets;
    
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (cell.model.id === thread.cellId) {
        const cellRect = cell.node.getBoundingClientRect();
        const top = thread.range ? thread.range.start : cellRect.height / 2;
        
        return {
          top: top,
          left: cellRect.width
        };
      }
    }
    
    return { top: 0, left: 0 };
  };
  
  return (
    <div className="jp-CommentSystem">
      {/* Comment badges */}
      {threads.map(thread => {
        const position = getThreadPosition(thread);
        return (
          <CommentBadge
            key={thread.id}
            thread={thread}
            onClick={() => setSelectedThreadId(thread.id)}
            isSelected={selectedThreadId === thread.id}
            top={position.top}
          />
        );
      })}
      
      {/* Selected comment thread */}
      {selectedThreadId && (
        <CommentThread
          thread={threads.find(t => t.id === selectedThreadId)!}
          commentService={commentService}
          currentUser={currentUser}
          onClose={() => setSelectedThreadId(null)}
          translator={translator}
          position={getThreadPosition(threads.find(t => t.id === selectedThreadId)!)}
        />
      )}
      
      {/* New thread input */}
      {newThreadCell && (
        <div 
          className="jp-CommentThread jp-CommentThread-new"
          style={{
            top: `${newThreadCell.top}px`,
            right: '32px'
          }}
        >
          <div className="jp-CommentThread-header">
            <div className="jp-CommentThread-title">
              {trans.__('New Comment')}
            </div>
            <div className="jp-CommentThread-actions">
              <button 
                className="jp-CommentThread-close"
                onClick={() => setNewThreadCell(null)}
                aria-label={trans.__('Close')}
              >
                ×
              </button>
            </div>
          </div>
          
          <CommentInput
            onSubmit={handleCreateThread}
            translator={translator}
          />
        </div>
      )}
    </div>
  );
}

/**
 * A namespace for CommentSystem statics.
 */
export namespace CommentSystemWidget {
  /**
   * Create a comment panel widget.
   */
  export function createPanel(options: {
    commentService: ICommentService;
    notebookPanel: NotebookPanel;
    currentUser: ICommentUser;
    translator?: ITranslator;
  }): ReactWidget {
    const { commentService, notebookPanel, currentUser, translator = nullTranslator } = options;
    
    return ReactWidget.create(
      <CommentPanel
        commentService={commentService}
        notebookPanel={notebookPanel}
        currentUser={currentUser}
        translator={translator}
      />
    );
  }
}