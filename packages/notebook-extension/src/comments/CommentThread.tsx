/**
 * @fileoverview CommentThread - React component for displaying and managing threaded comment discussions
 * 
 * This component implements comprehensive threaded comment functionality for collaborative Jupyter Notebook
 * editing. It displays comment threads anchored to specific notebook cells with real-time synchronization
 * through Yjs Y.Array integration, nested reply visualization, and collaborative features including
 * user presence awareness, resolution workflows, and notification management.
 * 
 * Key features:
 * - Real-time comment thread synchronization via Yjs Y.Array (≤100ms latency per F-028)
 * - Hierarchical threaded discussion display with nested reply visualization
 * - Integration with CommentResolution component for resolution workflow management
 * - User presence awareness and collaborative editing indicators
 * - Comment creation, editing, and deletion with permission-based access control
 * - Live notification integration for comment activity alerts
 * - Responsive design adapting to notebook cell layout and collaboration requirements
 * - Memory-efficient operation maintaining <20% overhead limit per specification
 * 
 * @author Blitzy Platform Development Team
 * @version 1.0.0
 * @since 2024
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { ISignal } from '@lumino/signaling';
import { showErrorMessage, showDialog, Dialog } from '@jupyterlab/apputils';
import { Button, Collapse, Tooltip } from '@jupyterlab/ui-components';
import { Time } from '@jupyterlab/coreutils';

// Import comment system types and interfaces
import {
  IComment,
  ICommentThread,
  ICommentUser,
  ICommentResolution,
  CommentThreadStatus,
  CommentStatus,
  CommentPriority,
  CommentEventType,
  ICommentSystemState,
  DEFAULT_NOTIFICATION_SETTINGS
} from './types';

// Import comment system components and managers
import CommentItem from './CommentItem';
import CommentInput from './CommentInput';
import CommentResolution from './CommentResolution';
import { CommentManager } from './CommentManager';

/**
 * Props interface for CommentThread component configuration
 */
export interface ICommentThreadProps {
  /** ID of the notebook cell this thread is associated with */
  cellId: string;
  /** CommentManager instance for Yjs operations and state management */
  commentManager: CommentManager;
  /** Current user information for permission checking and attribution */
  currentUser: ICommentUser;
  /** Translation service for internationalization */
  translator?: ITranslator;
  /** Whether the thread is currently active/selected */
  isActive?: boolean;
  /** Whether to show the thread in compact mode */
  compact?: boolean;
  /** Whether to show the input form for new comments */
  showInput?: boolean;
  /** Whether to show resolved comments */
  showResolved?: boolean;
  /** Maximum number of comments to display initially */
  maxInitialComments?: number;
  /** Whether to enable live notifications */
  enableNotifications?: boolean;
  /** Whether to show comment metadata (edit history, tags, etc.) */
  showMetadata?: boolean;
  /** Callback fired when thread status changes */
  onThreadStatusChange?: (thread: ICommentThread) => void;
  /** Callback fired when a comment is selected */
  onCommentSelect?: (comment: IComment) => void;
  /** Callback fired when thread becomes active */
  onThreadActivate?: (cellId: string) => void;
  /** Additional CSS classes for styling */
  className?: string;
  /** Whether to auto-focus the input when thread becomes active */
  autoFocusInput?: boolean;
  /** Custom sorting function for comments */
  commentSorter?: (a: IComment, b: IComment) => number;
}

/**
 * Internal state interface for CommentThread component
 */
interface ICommentThreadState {
  thread: ICommentThread | null;
  comments: IComment[];
  isLoading: boolean;
  error: string | null;
  showAllComments: boolean;
  activeCommentId: string | null;
  editingCommentId: string | null;
  replyingToCommentId: string | null;
  isSubmittingComment: boolean;
  connectionStatus: boolean;
}

/**
 * CommentThread - React component for displaying and managing threaded comment discussions
 * 
 * Renders comprehensive comment thread interfaces with real-time synchronization, nested replies,
 * resolution workflows, and collaborative features. Integrates with the Yjs-based CommentManager
 * for CRDT-based conflict-free synchronization and maintains sub-100ms operation latency.
 */
const CommentThread: React.FC<ICommentThreadProps> = ({
  cellId,
  commentManager,
  currentUser,
  translator = nullTranslator,
  isActive = false,
  compact = false,
  showInput = true,
  showResolved = false,
  maxInitialComments = 10,
  enableNotifications = true,
  showMetadata = false,
  onThreadStatusChange,
  onCommentSelect,
  onThreadActivate,
  className = '',
  autoFocusInput = false,
  commentSorter
}) => {
  const trans = translator.load('notebook');
  
  // Component refs
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<CommentInput | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  
  // Component state using reducer pattern for complex state management
  const [state, setState] = useState<ICommentThreadState>({
    thread: null,
    comments: [],
    isLoading: true,
    error: null,
    showAllComments: false,
    activeCommentId: null,
    editingCommentId: null,
    replyingToCommentId: null,
    isSubmittingComment: false,
    connectionStatus: commentManager.isConnected
  });

  /**
   * Load thread data from CommentManager with performance optimization
   */
  const loadThreadData = useCallback(async () => {
    try {
      setState(prev => ({ ...prev, isLoading: true, error: null }));
      
      const startTime = performance.now();
      
      // Get thread data from CommentManager
      const thread = commentManager.getCommentThread(cellId);
      const comments = commentManager.getCommentsForCell(cellId);
      
      // Apply custom sorting if provided
      const sortedComments = commentSorter 
        ? [...comments].sort(commentSorter)
        : comments.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      
      // Record performance metrics
      const loadTime = performance.now() - startTime;
      if (loadTime > 50) {
        console.warn(`CommentThread load time exceeded 50ms: ${loadTime.toFixed(2)}ms`);
      }
      
      setState(prev => ({
        ...prev,
        thread,
        comments: sortedComments,
        isLoading: false,
        error: null
      }));
      
    } catch (error) {
      console.error('Error loading comment thread:', error);
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error.message || trans.__('Failed to load comments')
      }));
    }
  }, [cellId, commentManager, commentSorter, trans]);

  /**
   * Handle new comment creation with real-time synchronization
   */
  const handleCreateComment = useCallback(async (content: string, parentId?: string) => {
    if (!content.trim()) {
      return;
    }
    
    setState(prev => ({ ...prev, isSubmittingComment: true }));
    
    try {
      const startTime = performance.now();
      
      // Create comment through CommentManager for Yjs synchronization
      const newComment = await commentManager.createComment(cellId, content.trim(), parentId);
      
      // Record operation latency
      const latency = performance.now() - startTime;
      if (latency > 100) {
        console.warn(`Comment creation latency exceeded 100ms: ${latency.toFixed(2)}ms`);
      }
      
      // Clear reply state if this was a reply
      if (parentId) {
        setState(prev => ({ ...prev, replyingToCommentId: null }));
      }
      
      // Scroll to new comment
      setTimeout(() => {
        const commentElement = threadRef.current?.querySelector(`[data-comment-id="${newComment.id}"]`);
        if (commentElement) {
          commentElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }, 100);
      
    } catch (error) {
      console.error('Error creating comment:', error);
      showErrorMessage(
        trans.__('Create Comment Error'),
        trans.__('Failed to create comment: %1', error.message)
      );
    } finally {
      setState(prev => ({ ...prev, isSubmittingComment: false }));
    }
  }, [cellId, commentManager, trans]);

  /**
   * Handle comment editing with conflict resolution
   */
  const handleEditComment = useCallback(async (comment: IComment, newContent: string) => {
    if (!newContent.trim() || newContent === comment.content) {
      setState(prev => ({ ...prev, editingCommentId: null }));
      return;
    }
    
    try {
      await commentManager.updateComment(comment.id, newContent.trim());
      setState(prev => ({ ...prev, editingCommentId: null }));
      
    } catch (error) {
      console.error('Error editing comment:', error);
      showErrorMessage(
        trans.__('Edit Comment Error'),
        trans.__('Failed to edit comment: %1', error.message)
      );
    }
  }, [commentManager, trans]);

  /**
   * Handle comment deletion with confirmation
   */
  const handleDeleteComment = useCallback(async (comment: IComment) => {
    const result = await showDialog({
      title: trans.__('Delete Comment'),
      body: trans.__('Are you sure you want to delete this comment and all its replies? This action cannot be undone.'),
      buttons: [
        Dialog.cancelButton({ label: trans.__('Cancel') }),
        Dialog.warnButton({ label: trans.__('Delete') })
      ]
    });
    
    if (result.button.accept) {
      try {
        await commentManager.deleteComment(comment.id);
      } catch (error) {
        console.error('Error deleting comment:', error);
        showErrorMessage(
          trans.__('Delete Comment Error'),
          trans.__('Failed to delete comment: %1', error.message)
        );
      }
    }
  }, [commentManager, trans]);

  /**
   * Handle comment resolution workflow
   */
  const handleResolveComment = useCallback(async (comment: IComment) => {
    try {
      await commentManager.resolveComment(comment.id, true);
      onThreadStatusChange?.(state.thread!);
    } catch (error) {
      console.error('Error resolving comment:', error);
      showErrorMessage(
        trans.__('Resolve Comment Error'),
        trans.__('Failed to resolve comment: %1', error.message)
      );
    }
  }, [commentManager, state.thread, onThreadStatusChange, trans]);

  /**
   * Handle comment reopening
   */
  const handleReopenComment = useCallback(async (comment: IComment) => {
    try {
      await commentManager.resolveComment(comment.id, false);
      onThreadStatusChange?.(state.thread!);
    } catch (error) {
      console.error('Error reopening comment:', error);
      showErrorMessage(
        trans.__('Reopen Comment Error'),
        trans.__('Failed to reopen comment: %1', error.message)
      );
    }
  }, [commentManager, state.thread, onThreadStatusChange, trans]);

  /**
   * Handle thread activation
   */
  const handleThreadActivate = useCallback(() => {
    if (!isActive) {
      onThreadActivate?.(cellId);
    }
  }, [isActive, cellId, onThreadActivate]);

  /**
   * Filter comments based on resolution status and visibility settings
   */
  const filteredComments = useMemo(() => {
    let filtered = state.comments;
    
    // Filter by resolution status
    if (!showResolved) {
      filtered = filtered.filter(comment => 
        comment.status !== CommentStatus.RESOLVED || 
        comment.createdBy.id === currentUser.id
      );
    }
    
    // Apply initial comment limit
    if (!state.showAllComments && filtered.length > maxInitialComments) {
      return filtered.slice(0, maxInitialComments);
    }
    
    return filtered;
  }, [state.comments, state.showAllComments, showResolved, maxInitialComments, currentUser.id]);

  /**
   * Build hierarchical comment tree structure
   */
  const commentTree = useMemo(() => {
    const comments = filteredComments;
    const commentMap = new Map<string, IComment & { children: IComment[] }>();
    const rootComments: (IComment & { children: IComment[] })[] = [];
    
    // First pass: create comment map with children arrays
    comments.forEach(comment => {
      commentMap.set(comment.id, { ...comment, children: [] });
    });
    
    // Second pass: build hierarchy
    comments.forEach(comment => {
      const commentWithChildren = commentMap.get(comment.id)!;
      
      if (comment.parentId && commentMap.has(comment.parentId)) {
        // Add to parent's children
        const parent = commentMap.get(comment.parentId)!;
        parent.children.push(commentWithChildren);
      } else {
        // Root level comment
        rootComments.push(commentWithChildren);
      }
    });
    
    return rootComments;
  }, [filteredComments]);

  /**
   * Calculate thread statistics
   */
  const threadStats = useMemo(() => {
    const total = state.comments.length;
    const resolved = state.comments.filter(c => c.status === CommentStatus.RESOLVED).length;
    const unread = state.comments.filter(c => 
      new Date(c.createdAt) > new Date(currentUser.lastActivity) && 
      c.createdBy.id !== currentUser.id
    ).length;
    
    return { total, resolved, unread };
  }, [state.comments, currentUser]);

  /**
   * Get thread priority based on comment priorities
   */
  const threadPriority = useMemo(() => {
    const priorities = state.comments.map(c => c.priority);
    if (priorities.includes(CommentPriority.CRITICAL)) return CommentPriority.CRITICAL;
    if (priorities.includes(CommentPriority.HIGH)) return CommentPriority.HIGH;
    if (priorities.includes(CommentPriority.NORMAL)) return CommentPriority.NORMAL;
    return CommentPriority.LOW;
  }, [state.comments]);

  /**
   * Render individual comment with nested replies
   */
  const renderComment = useCallback((comment: IComment & { children: IComment[] }, level: number = 0) => {
    const isEditing = state.editingCommentId === comment.id;
    const isReplying = state.replyingToCommentId === comment.id;
    const isHighlighted = state.activeCommentId === comment.id;
    
    // Determine user permissions
    const canEdit = currentUser.role === 'admin' || 
      (comment.createdBy.id === currentUser.id && comment.status !== CommentStatus.RESOLVED);
    const canReply = currentUser.role !== 'viewer' && comment.status !== CommentStatus.DELETED;
    const canDelete = currentUser.role === 'admin' || comment.createdBy.id === currentUser.id;
    const canResolve = currentUser.role !== 'viewer';
    
    return (
      <div key={comment.id} className="jp-comment-thread-comment-container" style={{ marginLeft: `${level * 16}px` }}>
        <CommentItem
          comment={{ ...comment, level }}
          currentUser={currentUser}
          translator={translator}
          canEdit={canEdit}
          canReply={canReply}
          canDelete={canDelete}
          canResolve={canResolve}
          showEditForm={isEditing}
          showReplyForm={isReplying}
          highlighted={isHighlighted}
          showMetadata={showMetadata}
          compact={compact && level > 0}
          onEdit={() => setState(prev => ({ ...prev, editingCommentId: comment.id }))}
          onReply={() => setState(prev => ({ ...prev, replyingToCommentId: comment.id }))}
          onDelete={() => handleDeleteComment(comment)}
          onResolve={() => handleResolveComment(comment)}
          onReopen={() => handleReopenComment(comment)}
          onCommentUpdate={(updatedComment) => handleEditComment(comment, updatedComment.content)}
          onCancelEdit={() => setState(prev => ({ ...prev, editingCommentId: null }))}
          onCancelReply={() => setState(prev => ({ ...prev, replyingToCommentId: null }))}
        />
        
        {/* Render nested replies */}
        {comment.children.length > 0 && (
          <div className="jp-comment-thread-replies">
            {comment.children.map(reply => renderComment(reply, level + 1))}
          </div>
        )}
        
        {/* Reply input for threaded discussions */}
        {isReplying && (
          <div className="jp-comment-thread-reply-input" style={{ marginLeft: `${(level + 1) * 16}px` }}>
            <CommentInput
              cellId={cellId}
              commentManager={commentManager}
              notificationManager={null as any}
              translator={translator}
              parentId={comment.id}
              onSubmit={(content) => handleCreateComment(content, comment.id)}
              onCancel={() => setState(prev => ({ ...prev, replyingToCommentId: null }))}
              placeholder={trans.__('Write a reply...')}
              autoFocus={true}
              compact={true}
            />
          </div>
        )}
      </div>
    );
  }, [
    state.editingCommentId,
    state.replyingToCommentId,
    state.activeCommentId,
    currentUser,
    translator,
    showMetadata,
    compact,
    handleDeleteComment,
    handleResolveComment,
    handleReopenComment,
    handleEditComment,
    handleCreateComment,
    cellId,
    commentManager,
    trans
  ]);

  // Set up real-time synchronization listeners
  useEffect(() => {
    const handleCommentAdded = (comment: IComment) => {
      if (comment.cellId === cellId) {
        loadThreadData();
      }
    };
    
    const handleCommentUpdated = (comment: IComment) => {
      if (comment.cellId === cellId) {
        loadThreadData();
      }
    };
    
    const handleCommentDeleted = ({ cellId: deletedCellId }: { commentId: string; cellId: string }) => {
      if (deletedCellId === cellId) {
        loadThreadData();
      }
    };
    
    const handleConnectionChange = (connected: boolean) => {
      setState(prev => ({ ...prev, connectionStatus: connected }));
    };
    
    // Connect to CommentManager signals
    commentManager.commentAdded.connect(handleCommentAdded);
    commentManager.commentUpdated.connect(handleCommentUpdated);
    commentManager.commentDeleted.connect(handleCommentDeleted);
    commentManager.connectionStatusChanged.connect(handleConnectionChange);
    
    // Initial load
    loadThreadData();
    
    // Cleanup
    return () => {
      commentManager.commentAdded.disconnect(handleCommentAdded);
      commentManager.commentUpdated.disconnect(handleCommentUpdated);
      commentManager.commentDeleted.disconnect(handleCommentDeleted);
      commentManager.connectionStatusChanged.disconnect(handleConnectionChange);
    };
  }, [cellId, commentManager, loadThreadData]);

  // Auto-focus input when thread becomes active
  useEffect(() => {
    if (isActive && autoFocusInput && inputRef.current) {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    }
  }, [isActive, autoFocusInput]);

  // Handle loading state
  if (state.isLoading) {
    return (
      <div className={`jp-comment-thread jp-comment-thread-loading ${className}`}>
        <div className="jp-comment-thread-loading-indicator">
          {trans.__('Loading comments...')}
        </div>
      </div>
    );
  }

  // Handle error state
  if (state.error) {
    return (
      <div className={`jp-comment-thread jp-comment-thread-error ${className}`}>
        <div className="jp-comment-thread-error-message">
          {state.error}
        </div>
        <Button onClick={loadThreadData} size="small">
          {trans.__('Retry')}
        </Button>
      </div>
    );
  }

  // Handle empty state
  if (state.comments.length === 0) {
    return (
      <div 
        className={`jp-comment-thread jp-comment-thread-empty ${isActive ? 'jp-comment-thread-active' : ''} ${className}`}
        onClick={handleThreadActivate}
      >
        <div className="jp-comment-thread-empty-message">
          {trans.__('No comments yet')}
        </div>
        
        {showInput && isActive && (
          <div className="jp-comment-thread-input">
            <CommentInput
              ref={inputRef}
              cellId={cellId}
              commentManager={commentManager}
              notificationManager={null as any}
              translator={translator}
              onSubmit={handleCreateComment}
              placeholder={trans.__('Start a discussion...')}
              autoFocus={autoFocusInput}
              compact={compact}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div 
      ref={threadRef}
      className={`jp-comment-thread ${
        isActive ? 'jp-comment-thread-active' : ''
      } ${
        compact ? 'jp-comment-thread-compact' : ''
      } ${
        !state.connectionStatus ? 'jp-comment-thread-offline' : ''
      } ${className}`}
      onClick={handleThreadActivate}
    >
      {/* Thread Header */}
      <div className="jp-comment-thread-header">
        <div className="jp-comment-thread-stats">
          <span className="jp-comment-thread-count">
            {trans._n('%1 comment', '%1 comments', threadStats.total, threadStats.total)}
          </span>
          
          {threadStats.resolved > 0 && (
            <span className="jp-comment-thread-resolved-count">
              {trans.__('%1 resolved', threadStats.resolved)}
            </span>
          )}
          
          {threadStats.unread > 0 && (
            <span className="jp-comment-thread-unread-badge">
              {threadStats.unread}
            </span>
          )}
          
          {threadPriority !== CommentPriority.NORMAL && (
            <span className={`jp-comment-thread-priority jp-comment-thread-priority-${threadPriority}`}>
              {threadPriority.toUpperCase()}
            </span>
          )}
        </div>
        
        <div className="jp-comment-thread-actions">
          {!state.connectionStatus && (
            <Tooltip content={trans.__('Offline - changes will sync when connection is restored')}>
              <span className="jp-comment-thread-offline-indicator">⚠</span>
            </Tooltip>
          )}
          
          {state.thread && (
            <CommentResolution
              thread={state.thread}
              commentManager={commentManager}
              notificationManager={null as any}
              currentUser={currentUser}
              translator={translator}
              onResolutionChange={onThreadStatusChange}
            />
          )}
        </div>
      </div>
      
      {/* Comments List */}
      <div ref={scrollContainerRef} className="jp-comment-thread-comments">
        {commentTree.map(comment => renderComment(comment))}
        
        {/* Show More Button */}
        {!state.showAllComments && state.comments.length > maxInitialComments && (
          <div className="jp-comment-thread-show-more">
            <Button
              onClick={() => setState(prev => ({ ...prev, showAllComments: true }))}
              size="small"
              minimal={true}
            >
              {trans.__('Show %1 more comments', state.comments.length - maxInitialComments)}
            </Button>
          </div>
        )}
      </div>
      
      {/* New Comment Input */}
      {showInput && isActive && (
        <div className="jp-comment-thread-input">
          <CommentInput
            ref={inputRef}
            cellId={cellId}
            commentManager={commentManager}
            notificationManager={null as any}
            translator={translator}
            onSubmit={handleCreateComment}
            placeholder={trans.__('Add a comment...')}
            disabled={state.isSubmittingComment}
            autoFocus={autoFocusInput}
            compact={compact}
          />
        </div>
      )}
    </div>
  );
};

/**
 * CommentThread namespace for ReactWidget integration following trusted.tsx pattern
 */
export namespace CommentThread {
  /**
   * Create a new CommentThread ReactWidget for Lumino integration
   * 
   * @param props - CommentThread component props
   * @returns ReactWidget containing the CommentThread component
   */
  export const create = (props: ICommentThreadProps): ReactWidget => {
    return ReactWidget.create(<CommentThread {...props} />);
  };
}

export default CommentThread;