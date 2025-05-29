/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ReactWidget, UseSignal } from '@jupyterlab/ui-components';
import { Widget } from '@lumino/widgets';
import { Signal, ISignal } from '@lumino/signaling';
import * as Y from 'yjs';

/**
 * Interface defining the structure of a comment in the collaborative notebook system.
 * Comments are stored in Yjs Y.Array for real-time synchronization across all connected clients.
 */
interface IComment {
  /** Unique identifier for the comment */
  id: string;
  /** ID of the cell this comment is attached to */
  cellId: string;
  /** Text content of the comment */
  content: string;
  /** User who created the comment */
  author: string;
  /** Avatar URL or initials for the author */
  authorAvatar?: string;
  /** Timestamp when comment was created */
  timestamp: number;
  /** Timestamp when comment was last modified */
  lastModified?: number;
  /** Current status of the comment (open, resolved, archived) */
  status: 'open' | 'resolved' | 'archived';
  /** ID of parent comment for threading (null for top-level comments) */
  parentId: string | null;
  /** Anchor information for specific text/output/metadata selections */
  anchor?: ICommentAnchor;
  /** Array of user IDs who have seen this comment */
  readBy: string[];
  /** Metadata for additional features like mentions, attachments, etc. */
  metadata?: Record<string, any>;
}

/**
 * Interface defining anchor points for comments within notebook cells.
 * Anchors allow comments to be attached to specific selections or elements.
 */
interface ICommentAnchor {
  /** Type of anchor: text selection, output, or metadata */
  type: 'text' | 'output' | 'metadata' | 'cell';
  /** For text anchors: start position of selection */
  startOffset?: number;
  /** For text anchors: end position of selection */
  endOffset?: number;
  /** For text anchors: selected text content for context */
  selectedText?: string;
  /** For output anchors: output index */
  outputIndex?: number;
  /** For metadata anchors: metadata key */
  metadataKey?: string;
  /** Additional context for maintaining anchor validity */
  context?: string;
}

/**
 * Props interface for the CommentSystem component.
 * Defines the required dependencies and configuration for comment functionality.
 */
interface ICommentSystemProps {
  /** Yjs document for real-time collaboration */
  yjsDoc: Y.Doc;
  /** ID of the current cell for scoping comments */
  cellId: string;
  /** Current user information */
  currentUser: {
    id: string;
    name: string;
    avatar?: string;
  };
  /** Optional callback for custom notification handling */
  onNotification?: (message: string, type: 'info' | 'warning' | 'error') => void;
  /** Optional callback for comment state changes */
  onCommentChange?: (comments: IComment[]) => void;
  /** Whether the component is in read-only mode */
  readOnly?: boolean;
  /** Theme configuration for styling */
  theme?: 'light' | 'dark';
}

/**
 * Internal state interface for managing component state.
 */
interface ICommentSystemState {
  /** Array of all comments for the current cell */
  comments: IComment[];
  /** Currently selected comment for actions */
  selectedComment: string | null;
  /** Whether the comment creation form is visible */
  showCreateForm: boolean;
  /** Current draft content for new comment */
  draftContent: string;
  /** Currently editing comment ID */
  editingComment: string | null;
  /** Current anchor being created */
  pendingAnchor: ICommentAnchor | null;
  /** Filter for comment display */
  filter: 'all' | 'open' | 'resolved';
  /** Unread comment count */
  unreadCount: number;
}

/**
 * CommentSystem React Component
 * 
 * Enables cell-level commenting and review workflows with threaded discussions,
 * comment anchoring, and resolution tracking. Renders through cellOverlay:comment
 * extension point with real-time comment synchronization via Yjs.
 * 
 * This component provides:
 * - Real-time collaborative commenting using Yjs Y.Array
 * - Threaded comment discussions with reply functionality
 * - Comment anchoring to text selections, outputs, and metadata
 * - Comment resolution workflow with status tracking
 * - Notification system for unread comments and activities
 * - Integration with JupyterLab's extension point system
 * 
 * @param props - Component props containing Yjs document, cell ID, and user info
 */
const CommentSystem: React.FC<ICommentSystemProps> = ({
  yjsDoc,
  cellId,
  currentUser,
  onNotification,
  onCommentChange,
  readOnly = false,
  theme = 'light'
}) => {
  // Component state management
  const [state, setState] = useState<ICommentSystemState>({
    comments: [],
    selectedComment: null,
    showCreateForm: false,
    draftContent: '',
    editingComment: null,
    pendingAnchor: null,
    filter: 'all',
    unreadCount: 0
  });

  // Refs for managing component lifecycle and DOM interactions
  const commentsArrayRef = useRef<Y.Array<any> | null>(null);
  const observerRef = useRef<() => void | null>(null);
  const notificationTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * Initialize Yjs Y.Array for comments with proper error handling and type safety.
   * Creates a shared array that automatically synchronizes across all connected clients.
   */
  const initializeCommentsArray = useCallback(() => {
    try {
      // Get or create the comments array for this specific cell
      const commentsArrayKey = `comments_${cellId}`;
      commentsArrayRef.current = yjsDoc.getArray(commentsArrayKey);
      
      // Set up observer for real-time updates
      const observer = () => {
        try {
          const yjsComments = commentsArrayRef.current?.toArray() || [];
          const parsedComments = yjsComments.map((comment: any) => {
            try {
              return typeof comment === 'string' ? JSON.parse(comment) : comment;
            } catch (e) {
              console.warn('Failed to parse comment:', e);
              return null;
            }
          }).filter(Boolean) as IComment[];

          // Update component state with new comments
          setState(prevState => {
            const newUnreadCount = parsedComments.filter(comment => 
              !comment.readBy.includes(currentUser.id) && 
              comment.author !== currentUser.id
            ).length;

            return {
              ...prevState,
              comments: parsedComments,
              unreadCount: newUnreadCount
            };
          });

          // Notify parent component of changes
          if (onCommentChange) {
            onCommentChange(parsedComments);
          }
        } catch (error) {
          console.error('Error processing comments update:', error);
          if (onNotification) {
            onNotification('Error loading comments', 'error');
          }
        }
      };

      // Observe changes to the comments array
      commentsArrayRef.current.observe(observer);
      observerRef.current = () => commentsArrayRef.current?.unobserve(observer);

      // Initial load of existing comments
      observer();
    } catch (error) {
      console.error('Failed to initialize comments array:', error);
      if (onNotification) {
        onNotification('Failed to initialize comment system', 'error');
      }
    }
  }, [yjsDoc, cellId, currentUser.id, onCommentChange, onNotification]);

  /**
   * Initialize the comment system when component mounts or dependencies change.
   */
  useEffect(() => {
    initializeCommentsArray();

    // Cleanup function to properly dispose of observers
    return () => {
      if (observerRef.current) {
        observerRef.current();
      }
      if (notificationTimeoutRef.current) {
        clearTimeout(notificationTimeoutRef.current);
      }
    };
  }, [initializeCommentsArray]);

  /**
   * Create a new comment with proper validation and error handling.
   * Adds the comment to the Yjs array for real-time synchronization.
   * 
   * @param content - The text content of the comment
   * @param parentId - Optional parent comment ID for threading
   * @param anchor - Optional anchor information for positioning
   */
  const createComment = useCallback(async (
    content: string,
    parentId: string | null = null,
    anchor: ICommentAnchor | null = null
  ) => {
    if (!content.trim() || readOnly) {
      return;
    }

    try {
      const newComment: IComment = {
        id: `comment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        cellId,
        content: content.trim(),
        author: currentUser.name,
        authorAvatar: currentUser.avatar,
        timestamp: Date.now(),
        status: 'open',
        parentId,
        anchor: anchor || state.pendingAnchor || undefined,
        readBy: [currentUser.id],
        metadata: {}
      };

      // Add comment to Yjs array for synchronization
      if (commentsArrayRef.current) {
        commentsArrayRef.current.push([JSON.stringify(newComment)]);
      }

      // Reset form state
      setState(prevState => ({
        ...prevState,
        showCreateForm: false,
        draftContent: '',
        pendingAnchor: null
      }));

      // Show success notification
      if (onNotification) {
        onNotification('Comment added successfully', 'info');
      }
    } catch (error) {
      console.error('Failed to create comment:', error);
      if (onNotification) {
        onNotification('Failed to create comment', 'error');
      }
    }
  }, [cellId, currentUser, state.pendingAnchor, readOnly, onNotification]);

  /**
   * Update an existing comment with validation and optimistic updates.
   * 
   * @param commentId - ID of the comment to update
   * @param updates - Partial comment object with fields to update
   */
  const updateComment = useCallback(async (commentId: string, updates: Partial<IComment>) => {
    if (readOnly) return;

    try {
      const commentIndex = state.comments.findIndex(c => c.id === commentId);
      if (commentIndex === -1) {
        throw new Error('Comment not found');
      }

      const updatedComment = {
        ...state.comments[commentIndex],
        ...updates,
        lastModified: Date.now()
      };

      // Update in Yjs array
      if (commentsArrayRef.current) {
        commentsArrayRef.current.delete(commentIndex, 1);
        commentsArrayRef.current.insert(commentIndex, [JSON.stringify(updatedComment)]);
      }

      // Clear editing state
      setState(prevState => ({
        ...prevState,
        editingComment: null
      }));

      if (onNotification) {
        onNotification('Comment updated successfully', 'info');
      }
    } catch (error) {
      console.error('Failed to update comment:', error);
      if (onNotification) {
        onNotification('Failed to update comment', 'error');
      }
    }
  }, [state.comments, readOnly, onNotification]);

  /**
   * Mark a comment as resolved or reopen it.
   * 
   * @param commentId - ID of the comment to resolve/reopen
   */
  const toggleCommentResolution = useCallback(async (commentId: string) => {
    const comment = state.comments.find(c => c.id === commentId);
    if (!comment || readOnly) return;

    const newStatus = comment.status === 'resolved' ? 'open' : 'resolved';
    await updateComment(commentId, { status: newStatus });

    if (onNotification) {
      const action = newStatus === 'resolved' ? 'resolved' : 'reopened';
      onNotification(`Comment ${action}`, 'info');
    }
  }, [state.comments, updateComment, readOnly, onNotification]);

  /**
   * Mark a comment as read by the current user.
   * 
   * @param commentId - ID of the comment to mark as read
   */
  const markCommentAsRead = useCallback(async (commentId: string) => {
    const comment = state.comments.find(c => c.id === commentId);
    if (!comment || comment.readBy.includes(currentUser.id)) return;

    const updatedReadBy = [...comment.readBy, currentUser.id];
    await updateComment(commentId, { readBy: updatedReadBy });
  }, [state.comments, currentUser.id, updateComment]);

  /**
   * Filter comments based on current filter state and organize into threads.
   */
  const filteredComments = useMemo(() => {
    let filtered = state.comments;

    // Apply status filter
    if (state.filter !== 'all') {
      filtered = filtered.filter(comment => comment.status === state.filter);
    }

    // Organize into threaded structure
    const topLevelComments = filtered.filter(comment => !comment.parentId);
    const commentThreads = topLevelComments.map(parent => ({
      parent,
      replies: filtered.filter(comment => comment.parentId === parent.id)
    }));

    return commentThreads;
  }, [state.comments, state.filter]);

  /**
   * Handle text selection for creating anchored comments.
   */
  const handleTextSelection = useCallback(() => {
    if (readOnly) return;

    const selection = window.getSelection();
    if (selection && selection.toString().trim()) {
      const selectedText = selection.toString().trim();
      const range = selection.getRangeAt(0);
      
      const anchor: ICommentAnchor = {
        type: 'text',
        startOffset: range.startOffset,
        endOffset: range.endOffset,
        selectedText,
        context: selectedText.substring(0, 50) // Store context for anchor validation
      };

      setState(prevState => ({
        ...prevState,
        pendingAnchor: anchor,
        showCreateForm: true
      }));
    }
  }, [readOnly]);

  /**
   * Render a single comment with all its interactive elements.
   * 
   * @param comment - The comment to render
   * @param isReply - Whether this comment is a reply to another comment
   */
  const renderComment = useCallback((comment: IComment, isReply: boolean = false) => {
    const isUnread = !comment.readBy.includes(currentUser.id);
    const isAuthor = comment.author === currentUser.name;
    const isEditing = state.editingComment === comment.id;

    return (
      <div
        key={comment.id}
        className={`jp-Collab-Comment ${isReply ? 'jp-Collab-Comment-reply' : ''} ${isUnread ? 'jp-Collab-Comment-unread' : ''} ${theme === 'dark' ? 'jp-Collab-Comment-dark' : ''}`}
        onClick={() => markCommentAsRead(comment.id)}
      >
        {/* Comment Header */}
        <div className="jp-Collab-Comment-header">
          <div className="jp-Collab-Comment-author">
            {comment.authorAvatar ? (
              <img 
                src={comment.authorAvatar} 
                alt={comment.author}
                className="jp-Collab-Comment-avatar"
              />
            ) : (
              <div className="jp-Collab-Comment-avatar-placeholder">
                {comment.author.charAt(0).toUpperCase()}
              </div>
            )}
            <span className="jp-Collab-Comment-author-name">{comment.author}</span>
          </div>
          <div className="jp-Collab-Comment-metadata">
            <span className="jp-Collab-Comment-timestamp">
              {new Date(comment.timestamp).toLocaleString()}
            </span>
            {comment.lastModified && (
              <span className="jp-Collab-Comment-modified">
                (edited {new Date(comment.lastModified).toLocaleString()})
              </span>
            )}
            <span className={`jp-Collab-Comment-status jp-Collab-Comment-status-${comment.status}`}>
              {comment.status}
            </span>
          </div>
        </div>

        {/* Comment Anchor Display */}
        {comment.anchor && (
          <div className="jp-Collab-Comment-anchor">
            <span className="jp-Collab-Comment-anchor-type">{comment.anchor.type}:</span>
            {comment.anchor.selectedText && (
              <span className="jp-Collab-Comment-anchor-text">"{comment.anchor.selectedText}"</span>
            )}
          </div>
        )}

        {/* Comment Content */}
        <div className="jp-Collab-Comment-content">
          {isEditing ? (
            <div className="jp-Collab-Comment-edit-form">
              <textarea
                value={state.draftContent}
                onChange={(e) => setState(prev => ({ ...prev, draftContent: e.target.value }))}
                className="jp-Collab-Comment-textarea"
                placeholder="Edit your comment..."
                rows={3}
              />
              <div className="jp-Collab-Comment-actions">
                <button
                  onClick={() => updateComment(comment.id, { content: state.draftContent })}
                  className="jp-Collab-Comment-button jp-Collab-Comment-button-primary"
                  disabled={!state.draftContent.trim()}
                >
                  Save
                </button>
                <button
                  onClick={() => setState(prev => ({ ...prev, editingComment: null, draftContent: '' }))}
                  className="jp-Collab-Comment-button jp-Collab-Comment-button-secondary"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="jp-Collab-Comment-text">{comment.content}</div>
          )}
        </div>

        {/* Comment Actions */}
        {!readOnly && (
          <div className="jp-Collab-Comment-footer">
            {!isReply && (
              <button
                onClick={() => setState(prev => ({ 
                  ...prev, 
                  showCreateForm: true, 
                  selectedComment: comment.id 
                }))}
                className="jp-Collab-Comment-action-button"
                title="Reply to comment"
              >
                Reply
              </button>
            )}
            {isAuthor && (
              <button
                onClick={() => setState(prev => ({ 
                  ...prev, 
                  editingComment: comment.id, 
                  draftContent: comment.content 
                }))}
                className="jp-Collab-Comment-action-button"
                title="Edit comment"
              >
                Edit
              </button>
            )}
            <button
              onClick={() => toggleCommentResolution(comment.id)}
              className={`jp-Collab-Comment-action-button ${comment.status === 'resolved' ? 'jp-Collab-Comment-action-reopen' : 'jp-Collab-Comment-action-resolve'}`}
              title={comment.status === 'resolved' ? 'Reopen comment' : 'Resolve comment'}
            >
              {comment.status === 'resolved' ? 'Reopen' : 'Resolve'}
            </button>
          </div>
        )}
      </div>
    );
  }, [currentUser, state.editingComment, state.draftContent, theme, markCommentAsRead, updateComment, toggleCommentResolution, readOnly]);

  /**
   * Render the comment creation form with anchor support.
   */
  const renderCreateForm = useCallback(() => {
    if (!state.showCreateForm || readOnly) return null;

    const isReply = state.selectedComment !== null;

    return (
      <div className="jp-Collab-Comment-create-form">
        <div className="jp-Collab-Comment-form-header">
          <h4>{isReply ? 'Reply to Comment' : 'Add Comment'}</h4>
          {state.pendingAnchor && (
            <div className="jp-Collab-Comment-anchor-preview">
              <span>Anchored to {state.pendingAnchor.type}: </span>
              {state.pendingAnchor.selectedText && (
                <span className="jp-Collab-Comment-anchor-preview-text">
                  "{state.pendingAnchor.selectedText}"
                </span>
              )}
            </div>
          )}
        </div>
        <textarea
          value={state.draftContent}
          onChange={(e) => setState(prev => ({ ...prev, draftContent: e.target.value }))}
          className="jp-Collab-Comment-textarea"
          placeholder={isReply ? "Write a reply..." : "Write a comment..."}
          rows={4}
          autoFocus
        />
        <div className="jp-Collab-Comment-form-actions">
          <button
            onClick={() => createComment(state.draftContent, state.selectedComment)}
            className="jp-Collab-Comment-button jp-Collab-Comment-button-primary"
            disabled={!state.draftContent.trim()}
          >
            {isReply ? 'Reply' : 'Comment'}
          </button>
          <button
            onClick={() => setState(prev => ({ 
              ...prev, 
              showCreateForm: false, 
              draftContent: '', 
              selectedComment: null, 
              pendingAnchor: null 
            }))}
            className="jp-Collab-Comment-button jp-Collab-Comment-button-secondary"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }, [state.showCreateForm, state.selectedComment, state.draftContent, state.pendingAnchor, readOnly, createComment]);

  /**
   * Main component render method.
   * Provides the complete comment system UI with filtering, threading, and real-time updates.
   */
  return (
    <div 
      className={`jp-Collab-CommentSystem ${theme === 'dark' ? 'jp-Collab-CommentSystem-dark' : ''}`}
      onMouseUp={handleTextSelection}
    >
      {/* Comment System Header */}
      <div className="jp-Collab-CommentSystem-header">
        <div className="jp-Collab-CommentSystem-title">
          <span>Comments</span>
          {state.unreadCount > 0 && (
            <span className="jp-Collab-Comment-unread-badge">
              {state.unreadCount}
            </span>
          )}
        </div>
        
        {/* Filter Controls */}
        <div className="jp-Collab-CommentSystem-filters">
          <select
            value={state.filter}
            onChange={(e) => setState(prev => ({ ...prev, filter: e.target.value as any }))}
            className="jp-Collab-CommentSystem-filter-select"
          >
            <option value="all">All Comments</option>
            <option value="open">Open Comments</option>
            <option value="resolved">Resolved Comments</option>
          </select>
        </div>

        {/* Add Comment Button */}
        {!readOnly && (
          <button
            onClick={() => setState(prev => ({ ...prev, showCreateForm: true }))}
            className="jp-Collab-Comment-button jp-Collab-Comment-button-add"
            title="Add comment"
          >
            +
          </button>
        )}
      </div>

      {/* Comment Creation Form */}
      {renderCreateForm()}

      {/* Comments List */}
      <div className="jp-Collab-CommentSystem-list">
        {filteredComments.length === 0 ? (
          <div className="jp-Collab-CommentSystem-empty">
            <p>No comments yet.</p>
            {!readOnly && (
              <p>Select text and add a comment to start the discussion!</p>
            )}
          </div>
        ) : (
          filteredComments.map(({ parent, replies }) => (
            <div key={parent.id} className="jp-Collab-Comment-thread">
              {renderComment(parent)}
              {replies.length > 0 && (
                <div className="jp-Collab-Comment-replies">
                  {replies.map(reply => renderComment(reply, true))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

/**
 * CommentSystemWidget
 * 
 * JupyterLab ReactWidget wrapper for the CommentSystem component.
 * This widget integrates with the cellOverlay:comment extension point
 * and provides proper lifecycle management for the collaborative comment system.
 * 
 * Key Features:
 * - Integrates with JupyterLab's widget system via ReactWidget
 * - Manages Yjs document connections and cleanup
 * - Provides cell-scoped comment functionality
 * - Handles theme switching and responsive design
 * - Implements proper disposal patterns for memory management
 */
export class CommentSystemWidget extends ReactWidget {
  private _yjsDoc: Y.Doc;
  private _cellId: string;
  private _currentUser: { id: string; name: string; avatar?: string };
  private _disposed = new Signal<this, void>(this);
  private _onNotification?: (message: string, type: 'info' | 'warning' | 'error') => void;
  private _onCommentChange?: (comments: IComment[]) => void;
  private _readOnly: boolean;
  private _theme: 'light' | 'dark';

  /**
   * Construct a new CommentSystemWidget.
   * 
   * @param options - Configuration options for the widget
   */
  constructor(options: {
    yjsDoc: Y.Doc;
    cellId: string;
    currentUser: { id: string; name: string; avatar?: string };
    onNotification?: (message: string, type: 'info' | 'warning' | 'error') => void;
    onCommentChange?: (comments: IComment[]) => void;
    readOnly?: boolean;
    theme?: 'light' | 'dark';
  }) {
    super();
    
    this._yjsDoc = options.yjsDoc;
    this._cellId = options.cellId;
    this._currentUser = options.currentUser;
    this._onNotification = options.onNotification;
    this._onCommentChange = options.onCommentChange;
    this._readOnly = options.readOnly || false;
    this._theme = options.theme || 'light';

    // Add CSS classes for proper styling
    this.addClass('jp-Collab-CommentSystem-widget');
    if (this._theme === 'dark') {
      this.addClass('jp-Collab-CommentSystem-widget-dark');
    }

    // Set widget properties
    this.title.label = 'Comments';
    this.title.caption = `Comments for cell ${this._cellId}`;
  }

  /**
   * Get the Yjs document instance.
   */
  get yjsDoc(): Y.Doc {
    return this._yjsDoc;
  }

  /**
   * Get the cell ID this widget is associated with.
   */
  get cellId(): string {
    return this._cellId;
  }

  /**
   * Get the current user information.
   */
  get currentUser(): { id: string; name: string; avatar?: string } {
    return this._currentUser;
  }

  /**
   * Signal emitted when the widget is disposed.
   */
  get disposed(): ISignal<this, void> {
    return this._disposed;
  }

  /**
   * Check if the widget is disposed.
   */
  get isDisposed(): boolean {
    return this._disposed.isDisposed;
  }

  /**
   * Update the theme of the comment system.
   * 
   * @param theme - The new theme to apply
   */
  setTheme(theme: 'light' | 'dark'): void {
    this._theme = theme;
    this.removeClass('jp-Collab-CommentSystem-widget-dark');
    if (theme === 'dark') {
      this.addClass('jp-Collab-CommentSystem-widget-dark');
    }
    this.update();
  }

  /**
   * Update the read-only state of the comment system.
   * 
   * @param readOnly - Whether the widget should be read-only
   */
  setReadOnly(readOnly: boolean): void {
    this._readOnly = readOnly;
    this.update();
  }

  /**
   * Render the React component.
   */
  protected render(): React.ReactElement {
    return (
      <CommentSystem
        yjsDoc={this._yjsDoc}
        cellId={this._cellId}
        currentUser={this._currentUser}
        onNotification={this._onNotification}
        onCommentChange={this._onCommentChange}
        readOnly={this._readOnly}
        theme={this._theme}
      />
    );
  }

  /**
   * Dispose of the widget and clean up resources.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    
    // Emit disposed signal
    this._disposed.emit();
    
    // Clear references to prevent memory leaks
    this._yjsDoc = null as any;
    this._onNotification = undefined;
    this._onCommentChange = undefined;
    
    // Call parent dispose
    super.dispose();
  }
}

/**
 * Factory function to create a CommentSystemWidget instance.
 * 
 * @param options - Configuration options for the widget
 * @returns A new CommentSystemWidget instance
 */
export function createCommentSystemWidget(options: {
  yjsDoc: Y.Doc;
  cellId: string;
  currentUser: { id: string; name: string; avatar?: string };
  onNotification?: (message: string, type: 'info' | 'warning' | 'error') => void;
  onCommentChange?: (comments: IComment[]) => void;
  readOnly?: boolean;
  theme?: 'light' | 'dark';
}): CommentSystemWidget {
  return new CommentSystemWidget(options);
}

// Export types for use by other components
export type { IComment, ICommentAnchor, ICommentSystemProps };

// Default export for the main component
export default CommentSystem;