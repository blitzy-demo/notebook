/**
 * CommentSystem component for Jupyter Notebook collaborative editing
 * 
 * Enables cell-level commenting and review workflows with threaded discussions,
 * comment anchoring, and resolution tracking. Renders through cellOverlay:comment
 * extension point with real-time comment synchronization via Yjs.
 * 
 * @module CommentSystem
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ReactWidget, showErrorMessage } from '@jupyterlab/apputils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { Notebook, NotebookPanel } from '@jupyterlab/notebook';
import { Cell, CodeCell, MarkdownCell } from '@jupyterlab/cells';
import { ISignal } from '@lumino/signaling';
import { Time } from '@jupyterlab/coreutils';
import * as Y from 'yjs';

/**
 * Interface for comment data structure
 */
export interface IComment {
  /** Unique comment identifier */
  id: string;
  /** Parent comment ID for threading (null for top-level comments) */
  parentId: string | null;
  /** Cell ID this comment is attached to */
  cellId: string;
  /** User who created the comment */
  author: string;
  /** User display name */
  authorName?: string;
  /** Comment content text */
  content: string;
  /** Creation timestamp */
  timestamp: number;
  /** Last modified timestamp */
  lastModified?: number;
  /** Comment resolution status */
  resolved: boolean;
  /** User who resolved the comment */
  resolvedBy?: string;
  /** Resolution timestamp */
  resolvedAt?: number;
  /** Anchor information for positioning */
  anchor?: ICommentAnchor;
  /** Number of unread replies */
  unreadReplies?: number;
}

/**
 * Interface for comment anchoring information
 */
export interface ICommentAnchor {
  /** Type of anchor (text, output, metadata) */
  type: 'text' | 'output' | 'metadata' | 'cell';
  /** Start position for text selections */
  startOffset?: number;
  /** End position for text selections */
  endOffset?: number;
  /** Selected text content */
  selectedText?: string;
  /** Output index for output anchors */
  outputIndex?: number;
  /** Metadata key for metadata anchors */
  metadataKey?: string;
  /** Cell area (input/output) for better positioning */
  cellArea?: 'input' | 'output' | 'metadata';
  /** Line number for code anchors */
  lineNumber?: number;
  /** Column position for precise anchoring */
  columnPosition?: number;
}

/**
 * Interface for comment notification settings
 */
export interface ICommentNotificationSettings {
  /** Enable email notifications */
  emailNotifications: boolean;
  /** Enable in-app notifications */
  inAppNotifications: boolean;
  /** Notify on replies to my comments */
  notifyOnReplies: boolean;
  /** Notify on mentions */
  notifyOnMentions: boolean;
}

/**
 * Props interface for CommentSystem component
 */
export interface ICommentSystemProps {
  /** Notebook panel instance */
  notebookPanel: NotebookPanel;
  /** Cell instance this comment system is attached to */
  cell: Cell;
  /** Translation support */
  translator?: ITranslator;
  /** Yjs shared array for comments */
  commentsArray: Y.Array<IComment>;
  /** Current user information */
  currentUser: {
    id: string;
    name: string;
  };
  /** Callback for comment notifications */
  onNotification?: (message: string, type: 'info' | 'warning' | 'error') => void;
}

/**
 * Props for individual comment thread component
 */
interface ICommentThreadProps {
  comment: IComment;
  replies: IComment[];
  onReply: (parentId: string, content: string) => void;
  onResolve: (commentId: string) => void;
  onEdit: (commentId: string, newContent: string) => void;
  onDelete: (commentId: string) => void;
  currentUser: { id: string; name: string };
  translator: ITranslator;
  isResolved: boolean;
}

/**
 * Individual comment thread component
 */
const CommentThread: React.FC<ICommentThreadProps> = ({
  comment,
  replies,
  onReply,
  onResolve,
  onEdit,
  onDelete,
  currentUser,
  translator,
  isResolved
}) => {
  const [isReplying, setIsReplying] = useState(false);
  const [replyContent, setReplyContent] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(comment.content);
  const [showReplies, setShowReplies] = useState(replies.length > 0);
  
  const trans = translator.load('jupyter-notebook');
  
  const handleReply = useCallback(() => {
    if (replyContent.trim()) {
      onReply(comment.id, replyContent.trim());
      setReplyContent('');
      setIsReplying(false);
      setShowReplies(true);
    }
  }, [comment.id, replyContent, onReply]);
  
  const handleEdit = useCallback(() => {
    if (editContent.trim() && editContent !== comment.content) {
      onEdit(comment.id, editContent.trim());
    }
    setIsEditing(false);
  }, [comment.id, comment.content, editContent, onEdit]);
  
  const handleResolve = useCallback(() => {
    onResolve(comment.id);
  }, [comment.id, onResolve]);
  
  const formatTimestamp = (timestamp: number): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return trans.__('just now');
    if (diffMins < 60) return trans.__('%1 minutes ago', diffMins);
    if (diffHours < 24) return trans.__('%1 hours ago', diffHours);
    if (diffDays < 7) return trans.__('%1 days ago', diffDays);
    return date.toLocaleDateString();
  };
  
  const canEdit = currentUser.id === comment.author;
  const canResolve = !isResolved && (currentUser.id === comment.author || comment.parentId === null);
  
  return (
    <div className={`jp-Collab-comment-thread ${isResolved ? 'jp-Collab-comment-resolved' : ''}`}>
      <div className="jp-Collab-comment-main">
        <div className="jp-Collab-comment-header">
          <div className="jp-Collab-comment-author">
            <span className="jp-Collab-comment-author-name">
              {comment.authorName || comment.author}
            </span>
            <span className="jp-Collab-comment-timestamp">
              {formatTimestamp(comment.timestamp)}
            </span>
            {comment.lastModified && comment.lastModified > comment.timestamp && (
              <span className="jp-Collab-comment-edited">
                {trans.__('(edited)')}
              </span>
            )}
          </div>
          <div className="jp-Collab-comment-actions">
            {canEdit && !isResolved && (
              <button
                className="jp-Collab-comment-action-button"
                onClick={() => setIsEditing(!isEditing)}
                title={trans.__('Edit comment')}
              >
                ✏️
              </button>
            )}
            {canResolve && (
              <button
                className="jp-Collab-comment-action-button jp-Collab-comment-resolve"
                onClick={handleResolve}
                title={trans.__('Resolve thread')}
              >
                ✓
              </button>
            )}
            {canEdit && (
              <button
                className="jp-Collab-comment-action-button jp-Collab-comment-delete"
                onClick={() => onDelete(comment.id)}
                title={trans.__('Delete comment')}
              >
                🗑️
              </button>
            )}
          </div>
        </div>
        
        <div className="jp-Collab-comment-content">
          {isEditing ? (
            <div className="jp-Collab-comment-edit-form">
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="jp-Collab-comment-edit-textarea"
                rows={3}
                autoFocus
              />
              <div className="jp-Collab-comment-edit-actions">
                <button
                  className="jp-Collab-comment-edit-save"
                  onClick={handleEdit}
                  disabled={!editContent.trim()}
                >
                  {trans.__('Save')}
                </button>
                <button
                  className="jp-Collab-comment-edit-cancel"
                  onClick={() => {
                    setIsEditing(false);
                    setEditContent(comment.content);
                  }}
                >
                  {trans.__('Cancel')}
                </button>
              </div>
            </div>
          ) : (
            <div className="jp-Collab-comment-text">
              {comment.content}
            </div>
          )}
        </div>
        
        {comment.anchor && comment.anchor.selectedText && (
          <div className="jp-Collab-comment-anchor">
            <div className="jp-Collab-comment-anchor-label">
              {trans.__('Referenced text:')}
            </div>
            <div className="jp-Collab-comment-anchor-text">
              "{comment.anchor.selectedText}"
            </div>
          </div>
        )}
        
        {!isResolved && (
          <div className="jp-Collab-comment-reply-section">
            {!isReplying ? (
              <button
                className="jp-Collab-comment-reply-button"
                onClick={() => setIsReplying(true)}
              >
                {trans.__('Reply')}
              </button>
            ) : (
              <div className="jp-Collab-comment-reply-form">
                <textarea
                  value={replyContent}
                  onChange={(e) => setReplyContent(e.target.value)}
                  placeholder={trans.__('Write a reply...')}
                  className="jp-Collab-comment-reply-textarea"
                  rows={2}
                  autoFocus
                />
                <div className="jp-Collab-comment-reply-actions">
                  <button
                    className="jp-Collab-comment-reply-post"
                    onClick={handleReply}
                    disabled={!replyContent.trim()}
                  >
                    {trans.__('Reply')}
                  </button>
                  <button
                    className="jp-Collab-comment-reply-cancel"
                    onClick={() => {
                      setIsReplying(false);
                      setReplyContent('');
                    }}
                  >
                    {trans.__('Cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      
      {replies.length > 0 && (
        <div className="jp-Collab-comment-replies">
          <div className="jp-Collab-comment-replies-header">
            <button
              className="jp-Collab-comment-replies-toggle"
              onClick={() => setShowReplies(!showReplies)}
            >
              {showReplies ? '▼' : '▶'} {trans._n('%1 reply', '%1 replies', replies.length)}
            </button>
          </div>
          {showReplies && (
            <div className="jp-Collab-comment-replies-list">
              {replies.map((reply) => (
                <CommentThread
                  key={reply.id}
                  comment={reply}
                  replies={[]}
                  onReply={onReply}
                  onResolve={onResolve}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  currentUser={currentUser}
                  translator={translator}
                  isResolved={isResolved}
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
 * Main CommentSystem React component
 */
const CommentSystem: React.FC<ICommentSystemProps> = ({
  notebookPanel,
  cell,
  translator = nullTranslator,
  commentsArray,
  currentUser,
  onNotification
}) => {
  const [comments, setComments] = useState<IComment[]>([]);
  const [isVisible, setIsVisible] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [selectedAnchor, setSelectedAnchor] = useState<ICommentAnchor | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [lastReadTimestamp, setLastReadTimestamp] = useState(Date.now());
  const [filterResolved, setFilterResolved] = useState(false);
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest' | 'unresolved'>('unresolved');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const commentsPanelRef = useRef<HTMLDivElement>(null);
  const trans = translator.load('jupyter-notebook');
  
  // Generate unique comment ID
  const generateCommentId = useCallback(() => {
    return `comment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }, []);
  
  // Enhanced anchor detection for different cell areas
  const detectAnchorFromSelection = useCallback((): ICommentAnchor | null => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }
    
    const range = selection.getRangeAt(0);
    const cellNode = cell.node;
    
    // Check if selection is within the cell
    if (!cellNode.contains(range.commonAncestorContainer)) {
      return null;
    }
    
    const selectedText = selection.toString().trim();
    if (selectedText.length === 0 || selectedText.length > 1000) {
      return null;
    }
    
    // Determine the anchor type and area
    const inputArea = cellNode.querySelector('.jp-InputArea-editor');
    const outputArea = cellNode.querySelector('.jp-OutputArea');
    const metadataArea = cellNode.querySelector('.jp-Notebook-metadata');
    
    let anchorType: ICommentAnchor['type'] = 'text';
    let cellArea: ICommentAnchor['cellArea'] = 'input';
    let lineNumber: number | undefined;
    let columnPosition: number | undefined;
    
    if (inputArea && inputArea.contains(range.commonAncestorContainer)) {
      cellArea = 'input';
      // Try to detect line number for code cells
      if (cell instanceof CodeCell) {
        try {
          const editor = (cell as CodeCell).editor;
          if (editor) {
            const doc = editor.doc;
            const pos = editor.getPositionAt(range.startOffset);
            if (pos) {
              lineNumber = pos.line + 1;
              columnPosition = pos.column;
            }
          }
        } catch (err) {
          console.warn('Could not determine cursor position:', err);
        }
      }
    } else if (outputArea && outputArea.contains(range.commonAncestorContainer)) {
      cellArea = 'output';
      anchorType = 'output';
      
      // Find output index
      const outputs = outputArea.querySelectorAll('.jp-OutputArea-output');
      for (let i = 0; i < outputs.length; i++) {
        if (outputs[i].contains(range.commonAncestorContainer)) {
          return {
            type: anchorType,
            cellArea,
            selectedText,
            outputIndex: i,
            startOffset: range.startOffset,
            endOffset: range.endOffset
          };
        }
      }
    } else if (metadataArea && metadataArea.contains(range.commonAncestorContainer)) {
      cellArea = 'metadata';
      anchorType = 'metadata';
    }
    
    return {
      type: anchorType,
      cellArea,
      selectedText,
      startOffset: range.startOffset,
      endOffset: range.endOffset,
      lineNumber,
      columnPosition
    };
  }, [cell]);
  
  // Handle errors with user-friendly messages
  const handleError = useCallback((error: any, context: string) => {
    console.error(`CommentSystem error in ${context}:`, error);
    const message = error?.message || 'An unexpected error occurred';
    setError(`${context}: ${message}`);
    
    if (onNotification) {
      onNotification(`Error: ${message}`, 'error');
    }
    
    // Clear error after 5 seconds
    setTimeout(() => setError(null), 5000);
  }, [onNotification]);
  
  // Subscribe to Yjs comments array changes
  useEffect(() => {
    const handleCommentsChange = () => {
      const allComments = commentsArray.toArray() as IComment[];
      const cellComments = allComments.filter(comment => comment.cellId === cell.model.id);
      setComments(cellComments);
      
      // Calculate unread comments
      const unread = cellComments.filter(comment => 
        comment.timestamp > lastReadTimestamp && comment.author !== currentUser.id
      ).length;
      setUnreadCount(unread);
    };
    
    // Initial load
    handleCommentsChange();
    
    // Subscribe to changes
    commentsArray.observe(handleCommentsChange);
    
    return () => {
      commentsArray.unobserve(handleCommentsChange);
    };
  }, [commentsArray, cell.model.id, currentUser.id, lastReadTimestamp]);
  
  // Handle selection changes to enable text anchoring
  useEffect(() => {
    const handleSelectionChange = () => {
      try {
        const anchor = detectAnchorFromSelection();
        setSelectedAnchor(anchor);
      } catch (err) {
        handleError(err, 'selection detection');
        setSelectedAnchor(null);
      }
    };
    
    // Debounce selection changes to avoid excessive updates
    let timeoutId: NodeJS.Timeout;
    const debouncedHandler = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(handleSelectionChange, 150);
    };
    
    document.addEventListener('selectionchange', debouncedHandler);
    return () => {
      document.removeEventListener('selectionchange', debouncedHandler);
      clearTimeout(timeoutId);
    };
  }, [cell, detectAnchorFromSelection, handleError]);
  
  // Handle new comment creation
  const handleCreateComment = useCallback(async (content: string, parentId: string | null = null) => {
    if (!content.trim()) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      // Validate content length
      if (content.length > 10000) {
        throw new Error('Comment is too long (maximum 10,000 characters)');
      }
      
      // Check for potential spam
      const words = content.trim().split(/\s+/);
      if (words.length < 1) {
        throw new Error('Comment cannot be empty');
      }
      
      const newCommentData: IComment = {
        id: generateCommentId(),
        parentId,
        cellId: cell.model.id,
        author: currentUser.id,
        authorName: currentUser.name,
        content: content.trim(),
        timestamp: Date.now(),
        resolved: false,
        anchor: selectedAnchor || { type: 'cell' }
      };
      
      // Add to Yjs array for real-time synchronization
      commentsArray.push([newCommentData]);
      
      // Clear form state after creating comment
      if (!parentId) {
        setNewComment('');
        setSelectedAnchor(null);
        
        // Clear text selection
        const selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
        }
      }
      
      // Notify about new comment
      if (onNotification) {
        onNotification(
          parentId 
            ? trans.__('Reply posted successfully')
            : trans.__('Comment created successfully'),
          'info'
        );
      }
    } catch (err) {
      handleError(err, 'creating comment');
    } finally {
      setIsLoading(false);
    }
  }, [cell.model.id, currentUser, selectedAnchor, commentsArray, generateCommentId, trans, onNotification, handleError]);
  
  // Handle comment editing
  const handleEditComment = useCallback(async (commentId: string, newContent: string) => {
    if (!newContent.trim()) {
      if (onNotification) {
        onNotification(trans.__('Comment cannot be empty'), 'warning');
      }
      return;
    }
    
    if (newContent.length > 10000) {
      if (onNotification) {
        onNotification(trans.__('Comment is too long (maximum 10,000 characters)'), 'warning');
      }
      return;
    }
    
    setIsLoading(true);
    
    try {
      const allComments = commentsArray.toArray() as IComment[];
      const commentIndex = allComments.findIndex(comment => comment.id === commentId);
      
      if (commentIndex === -1) {
        throw new Error('Comment not found');
      }
      
      const existingComment = allComments[commentIndex];
      
      // Check permissions
      if (existingComment.author !== currentUser.id) {
        throw new Error('You can only edit your own comments');
      }
      
      const updatedComment: IComment = {
        ...existingComment,
        content: newContent.trim(),
        lastModified: Date.now()
      };
      
      commentsArray.delete(commentIndex, 1);
      commentsArray.insert(commentIndex, [updatedComment]);
      
      if (onNotification) {
        onNotification(trans.__('Comment updated successfully'), 'info');
      }
    } catch (err) {
      handleError(err, 'editing comment');
    } finally {
      setIsLoading(false);
    }
  }, [commentsArray, currentUser.id, trans, onNotification, handleError]);
  
  // Handle comment deletion
  const handleDeleteComment = useCallback(async (commentId: string) => {
    // Confirm deletion for safety
    const confirmed = window.confirm(trans.__('Are you sure you want to delete this comment? This action cannot be undone.'));
    if (!confirmed) return;
    
    setIsLoading(true);
    
    try {
      const allComments = commentsArray.toArray() as IComment[];
      const commentIndex = allComments.findIndex(comment => comment.id === commentId);
      
      if (commentIndex === -1) {
        throw new Error('Comment not found');
      }
      
      const comment = allComments[commentIndex];
      
      // Check permissions
      if (comment.author !== currentUser.id) {
        throw new Error('You can only delete your own comments');
      }
      
      // Check if comment has replies
      const hasReplies = allComments.some(c => c.parentId === commentId);
      if (hasReplies) {
        const confirmWithReplies = window.confirm(
          trans.__('This comment has replies. Deleting it will also delete all replies. Continue?')
        );
        if (!confirmWithReplies) return;
        
        // Delete all replies first
        const repliesToDelete = allComments
          .map((c, idx) => ({ comment: c, index: idx }))
          .filter(({ comment }) => comment.parentId === commentId)
          .sort((a, b) => b.index - a.index); // Delete from end to beginning to maintain indices
        
        repliesToDelete.forEach(({ index }) => {
          commentsArray.delete(index, 1);
        });
      }
      
      // Delete the main comment
      const finalIndex = commentsArray.toArray().findIndex((c: IComment) => c.id === commentId);
      if (finalIndex !== -1) {
        commentsArray.delete(finalIndex, 1);
      }
      
      if (onNotification) {
        onNotification(
          hasReplies 
            ? trans.__('Comment and replies deleted successfully')
            : trans.__('Comment deleted successfully'), 
          'info'
        );
      }
    } catch (err) {
      handleError(err, 'deleting comment');
    } finally {
      setIsLoading(false);
    }
  }, [commentsArray, currentUser.id, trans, onNotification, handleError]);
  
  // Handle comment resolution
  const handleResolveComment = useCallback(async (commentId: string) => {
    setIsLoading(true);
    
    try {
      const allComments = commentsArray.toArray() as IComment[];
      const commentIndex = allComments.findIndex(comment => comment.id === commentId);
      
      if (commentIndex === -1) {
        throw new Error('Comment not found');
      }
      
      const comment = allComments[commentIndex];
      
      // Check permissions - author or thread starter can resolve
      const isThreadStarter = !comment.parentId;
      const canResolve = comment.author === currentUser.id || isThreadStarter;
      
      if (!canResolve) {
        throw new Error('You can only resolve your own comments or comment threads you started');
      }
      
      const updatedComment: IComment = {
        ...comment,
        resolved: true,
        resolvedBy: currentUser.id,
        resolvedAt: Date.now()
      };
      
      commentsArray.delete(commentIndex, 1);
      commentsArray.insert(commentIndex, [updatedComment]);
      
      if (onNotification) {
        onNotification(trans.__('Comment thread resolved'), 'info');
      }
    } catch (err) {
      handleError(err, 'resolving comment');
    } finally {
      setIsLoading(false);
    }
  }, [commentsArray, currentUser.id, trans, onNotification, handleError]);
  
  // Mark comments as read when panel is opened
  const handleToggleVisibility = useCallback(() => {
    const newVisibility = !isVisible;
    setIsVisible(newVisibility);
    
    if (newVisibility) {
      setLastReadTimestamp(Date.now());
      setUnreadCount(0);
    }
  }, [isVisible]);
  
  // Organize comments into threads with filtering and sorting
  const organizeComments = useCallback(() => {
    let topLevelComments = comments.filter(comment => !comment.parentId);
    
    // Apply resolved filter
    if (filterResolved) {
      topLevelComments = topLevelComments.filter(comment => !comment.resolved);
    }
    
    const commentThreads = topLevelComments.map(comment => ({
      comment,
      replies: comments.filter(reply => reply.parentId === comment.id)
        .sort((a, b) => a.timestamp - b.timestamp)
    }));
    
    // Apply sorting
    return commentThreads.sort((a, b) => {
      switch (sortOrder) {
        case 'oldest':
          return a.comment.timestamp - b.comment.timestamp;
        case 'newest':
          return b.comment.timestamp - a.comment.timestamp;
        case 'unresolved':
        default:
          // Show unresolved comments first, then sort by timestamp
          if (a.comment.resolved !== b.comment.resolved) {
            return a.comment.resolved ? 1 : -1;
          }
          return b.comment.timestamp - a.comment.timestamp;
      }
    });
  }, [comments, filterResolved, sortOrder]);
  
  // Memoize organized comments for performance
  const commentThreads = useMemo(() => organizeComments(), [organizeComments]);
  

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Ctrl+Enter to post comment
      if (event.ctrlKey && event.key === 'Enter' && isVisible && newComment.trim()) {
        event.preventDefault();
        handleCreateComment(newComment);
      }
      
      // Escape to close panel
      if (event.key === 'Escape' && isVisible) {
        event.preventDefault();
        setIsVisible(false);
      }
      
      // Ctrl+/ to toggle comments panel
      if (event.ctrlKey && event.key === '/') {
        event.preventDefault();
        handleToggleVisibility();
      }
    };
    
    if (isVisible) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isVisible, newComment, handleCreateComment, handleToggleVisibility]);
  
  const hasComments = commentThreads.length > 0;
  const hasUnresolvedComments = commentThreads.some(thread => !thread.comment.resolved);
  
  return (
    <div className="jp-Collab-comment-system">
      {/* Comment indicator button */}
      <button
        className={`jp-Collab-comment-indicator ${hasComments ? 'jp-Collab-comment-has-comments' : ''} ${hasUnresolvedComments ? 'jp-Collab-comment-has-unresolved' : ''}`}
        onClick={handleToggleVisibility}
        title={trans.__('Comments (%1)', commentThreads.length)}
      >
        💬
        {unreadCount > 0 && (
          <span className="jp-Collab-comment-unread-badge">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>
      
      {/* Comments panel */}
      {isVisible && (
        <div
          ref={commentsPanelRef}
          className="jp-Collab-comment-panel"
        >
          <div className="jp-Collab-comment-panel-header">
            <h3 className="jp-Collab-comment-panel-title">
              {trans.__('Comments')} ({commentThreads.length})
            </h3>
            <div className="jp-Collab-comment-panel-controls">
              <select
                className="jp-Collab-comment-sort-select"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value as typeof sortOrder)}
                title={trans.__('Sort comments')}
              >
                <option value="unresolved">{trans.__('Unresolved first')}</option>
                <option value="newest">{trans.__('Newest first')}</option>
                <option value="oldest">{trans.__('Oldest first')}</option>
              </select>
              <label className="jp-Collab-comment-filter-label">
                <input
                  type="checkbox"
                  checked={filterResolved}
                  onChange={(e) => setFilterResolved(e.target.checked)}
                />
                {trans.__('Hide resolved')}
              </label>
              <button
                className="jp-Collab-comment-panel-close"
                onClick={() => setIsVisible(false)}
                title={trans.__('Close comments')}
              >
                ✕
              </button>
            </div>
          </div>
          
          {/* Error display */}
          {error && (
            <div className="jp-Collab-comment-error">
              <div className="jp-Collab-comment-error-content">
                <span className="jp-Collab-comment-error-icon">⚠️</span>
                <span className="jp-Collab-comment-error-message">{error}</span>
                <button
                  className="jp-Collab-comment-error-close"
                  onClick={() => setError(null)}
                  title={trans.__('Dismiss error')}
                >
                  ✕
                </button>
              </div>
            </div>
          )}
          
          {/* Loading indicator */}
          {isLoading && (
            <div className="jp-Collab-comment-loading">
              <div className="jp-Collab-comment-loading-spinner"></div>
              <span>{trans.__('Processing...')}</span>
            </div>
          )}
          
          <div className="jp-Collab-comment-panel-content">
            {/* New comment form */}
            <div className="jp-Collab-comment-new">
              <div className="jp-Collab-comment-new-header">
                <span className="jp-Collab-comment-new-author">
                  {currentUser.name}
                </span>
                {selectedAnchor && selectedAnchor.selectedText && (
                  <div className="jp-Collab-comment-new-anchor">
                    <span className="jp-Collab-comment-new-anchor-label">
                      {trans.__('Commenting on:')}
                    </span>
                    <span className="jp-Collab-comment-new-anchor-text">
                      "{selectedAnchor.selectedText.length > 50 
                        ? selectedAnchor.selectedText.substring(0, 50) + '...'
                        : selectedAnchor.selectedText}"
                    </span>
                  </div>
                )}
              </div>
              <textarea
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.ctrlKey && e.key === 'Enter' && newComment.trim() && !isLoading) {
                    e.preventDefault();
                    handleCreateComment(newComment);
                  }
                }}
                placeholder={
                  selectedAnchor?.selectedText 
                    ? trans.__('Comment on the selected text... (Ctrl+Enter to post)')
                    : trans.__('Add a comment... (Ctrl+Enter to post)')
                }
                className="jp-Collab-comment-new-textarea"
                rows={3}
                maxLength={10000}
                disabled={isLoading}
              />
              <div className="jp-Collab-comment-new-actions">
                <button
                  className="jp-Collab-comment-new-post"
                  onClick={() => handleCreateComment(newComment)}
                  disabled={!newComment.trim() || isLoading}
                >
                  {isLoading ? trans.__('Posting...') : trans.__('Post Comment')}
                </button>
                {selectedAnchor && (
                  <button
                    className="jp-Collab-comment-new-clear-selection"
                    onClick={() => setSelectedAnchor(null)}
                    disabled={isLoading}
                  >
                    {trans.__('Clear Selection')}
                  </button>
                )}
                <div className="jp-Collab-comment-new-info">
                  <span className="jp-Collab-comment-char-count">
                    {newComment.length}/10000
                  </span>
                  {newComment.length > 8000 && (
                    <span className="jp-Collab-comment-char-warning">
                      {trans.__('Approaching character limit')}
                    </span>
                  )}
                </div>
              </div>
            </div>
            
            {/* Comment threads */}
            <div className="jp-Collab-comment-threads">
              {commentThreads.length === 0 ? (
                <div className="jp-Collab-comment-empty">
                  <div className="jp-Collab-comment-empty-icon">💭</div>
                  <div className="jp-Collab-comment-empty-text">
                    {filterResolved && comments.length > 0
                      ? trans.__('No unresolved comments. Clear the filter to see all comments.')
                      : comments.length > 0
                      ? trans.__('No comments match the current filter.')
                      : trans.__('No comments yet.')
                    }
                  </div>
                  {comments.length === 0 && (
                    <div className="jp-Collab-comment-empty-help">
                      <div>{trans.__('💡 Tips for commenting:')}</div>
                      <ul>
                        <li>{trans.__('Select text to comment on specific content')}</li>
                        <li>{trans.__('Use @username to mention collaborators')}</li>
                        <li>{trans.__('Press Ctrl+Enter to post comments quickly')}</li>
                        <li>{trans.__('Resolve threads when discussions are complete')}</li>
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {/* Comment statistics */}
                  <div className="jp-Collab-comment-stats">
                    <span className="jp-Collab-comment-stats-total">
                      {trans._n('%1 comment', '%1 comments', commentThreads.length)}
                    </span>
                    {commentThreads.some(t => !t.comment.resolved) && (
                      <span className="jp-Collab-comment-stats-unresolved">
                        ({trans._n('%1 unresolved', '%1 unresolved', 
                          commentThreads.filter(t => !t.comment.resolved).length)})
                      </span>
                    )}
                  </div>
                  
                  {/* Comment threads */}
                  {commentThreads.map((thread) => (
                    <CommentThread
                      key={thread.comment.id}
                      comment={thread.comment}
                      replies={thread.replies}
                      onReply={(parentId, content) => handleCreateComment(content, parentId)}
                      onResolve={handleResolveComment}
                      onEdit={handleEditComment}
                      onDelete={handleDeleteComment}
                      currentUser={currentUser}
                      translator={translator}
                      isResolved={thread.comment.resolved}
                    />
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Factory function to create CommentSystem ReactWidget
 */
export class CommentSystemComponent {
  /**
   * Create a new CommentSystem widget
   */
  static create(
    notebookPanel: NotebookPanel,
    cell: Cell,
    commentsArray: Y.Array<IComment>,
    currentUser: { id: string; name: string },
    translator?: ITranslator,
    onNotification?: (message: string, type: 'info' | 'warning' | 'error') => void
  ): ReactWidget {
    return ReactWidget.create(
      <CommentSystem
        notebookPanel={notebookPanel}
        cell={cell}
        commentsArray={commentsArray}
        currentUser={currentUser}
        translator={translator}
        onNotification={onNotification}
      />
    );
  }
}

export default CommentSystem;

/**
 * CSS Module for CommentSystem styling
 * Following JupyterLab design patterns with .jp-Collab- prefix
 */
export const COMMENT_SYSTEM_STYLES = `
/* Main comment system container */
.jp-Collab-comment-system {
  position: relative;
  z-index: 1000;
}

/* Comment indicator button */
.jp-Collab-comment-indicator {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background: var(--jp-layout-color2);
  color: var(--jp-ui-font-color1);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  transition: all 0.2s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}

.jp-Collab-comment-indicator:hover {
  background: var(--jp-layout-color3);
  transform: scale(1.05);
}

.jp-Collab-comment-indicator.jp-Collab-comment-has-comments {
  background: var(--jp-brand-color1);
  color: white;
}

.jp-Collab-comment-indicator.jp-Collab-comment-has-unresolved {
  background: var(--jp-warn-color1);
  animation: pulse 2s infinite;
}

/* Unread badge */
.jp-Collab-comment-unread-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  background: var(--jp-error-color1);
  color: white;
  border-radius: 10px;
  padding: 2px 6px;
  font-size: 10px;
  font-weight: bold;
  min-width: 16px;
  text-align: center;
}

/* Comment panel */
.jp-Collab-comment-panel {
  position: absolute;
  top: 32px;
  right: 0;
  width: 400px;
  max-width: 90vw;
  max-height: 80vh;
  background: var(--jp-layout-color1);
  border: 1px solid var(--jp-border-color1);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 1001;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Panel header */
.jp-Collab-comment-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--jp-border-color1);
  background: var(--jp-layout-color2);
  flex-shrink: 0;
}

.jp-Collab-comment-panel-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--jp-ui-font-color1);
}

.jp-Collab-comment-panel-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.jp-Collab-comment-sort-select {
  padding: 4px 8px;
  border: 1px solid var(--jp-border-color1);
  border-radius: 4px;
  background: var(--jp-layout-color1);
  color: var(--jp-ui-font-color1);
  font-size: 12px;
}

.jp-Collab-comment-filter-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--jp-ui-font-color2);
  cursor: pointer;
}

.jp-Collab-comment-panel-close {
  background: none;
  border: none;
  color: var(--jp-ui-font-color2);
  cursor: pointer;
  padding: 4px;
  border-radius: 2px;
  font-size: 16px;
}

.jp-Collab-comment-panel-close:hover {
  background: var(--jp-layout-color3);
  color: var(--jp-ui-font-color1);
}

/* Error display */
.jp-Collab-comment-error {
  background: var(--jp-error-color3);
  border-left: 4px solid var(--jp-error-color1);
  margin: 8px 12px;
  border-radius: 4px;
}

.jp-Collab-comment-error-content {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  gap: 8px;
}

.jp-Collab-comment-error-message {
  flex: 1;
  font-size: 12px;
  color: var(--jp-error-color1);
}

.jp-Collab-comment-error-close {
  background: none;
  border: none;
  color: var(--jp-error-color1);
  cursor: pointer;
  padding: 2px;
}

/* Loading indicator */
.jp-Collab-comment-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  color: var(--jp-ui-font-color2);
  font-size: 12px;
}

.jp-Collab-comment-loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--jp-border-color1);
  border-top: 2px solid var(--jp-brand-color1);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

/* Panel content */
.jp-Collab-comment-panel-content {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex: 1;
}

/* New comment form */
.jp-Collab-comment-new {
  padding: 16px;
  border-bottom: 1px solid var(--jp-border-color1);
  background: var(--jp-layout-color0);
  flex-shrink: 0;
}

.jp-Collab-comment-new-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.jp-Collab-comment-new-author {
  font-weight: 600;
  font-size: 12px;
  color: var(--jp-ui-font-color1);
}

.jp-Collab-comment-new-anchor {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.jp-Collab-comment-new-anchor-label {
  font-size: 10px;
  color: var(--jp-ui-font-color2);
}

.jp-Collab-comment-new-anchor-text {
  font-size: 11px;
  font-style: italic;
  color: var(--jp-ui-font-color2);
  background: var(--jp-layout-color2);
  padding: 2px 6px;
  border-radius: 3px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.jp-Collab-comment-new-textarea {
  width: 100%;
  min-height: 60px;
  padding: 8px;
  border: 1px solid var(--jp-border-color1);
  border-radius: 4px;
  background: var(--jp-layout-color1);
  color: var(--jp-ui-font-color1);
  font-family: var(--jp-ui-font-family);
  font-size: 13px;
  resize: vertical;
  outline: none;
}

.jp-Collab-comment-new-textarea:focus {
  border-color: var(--jp-brand-color1);
  box-shadow: 0 0 0 2px rgba(var(--jp-brand-color1-rgb), 0.2);
}

.jp-Collab-comment-new-textarea:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.jp-Collab-comment-new-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
  gap: 8px;
}

.jp-Collab-comment-new-post {
  background: var(--jp-brand-color1);
  color: white;
  border: none;
  border-radius: 4px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s ease;
}

.jp-Collab-comment-new-post:hover:not(:disabled) {
  background: var(--jp-brand-color0);
}

.jp-Collab-comment-new-post:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.jp-Collab-comment-new-clear-selection {
  background: none;
  border: 1px solid var(--jp-border-color1);
  border-radius: 4px;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--jp-ui-font-color1);
  cursor: pointer;
}

.jp-Collab-comment-new-clear-selection:hover:not(:disabled) {
  background: var(--jp-layout-color2);
}

.jp-Collab-comment-new-info {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  font-size: 10px;
  color: var(--jp-ui-font-color2);
}

.jp-Collab-comment-char-warning {
  color: var(--jp-warn-color1);
}

/* Comment threads */
.jp-Collab-comment-threads {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.jp-Collab-comment-stats {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  padding: 8px 12px;
  background: var(--jp-layout-color2);
  border-radius: 4px;
  font-size: 11px;
  color: var(--jp-ui-font-color2);
}

.jp-Collab-comment-stats-unresolved {
  color: var(--jp-warn-color1);
  font-weight: 500;
}

/* Empty state */
.jp-Collab-comment-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  text-align: center;
  color: var(--jp-ui-font-color2);
}

.jp-Collab-comment-empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
  opacity: 0.5;
}

.jp-Collab-comment-empty-text {
  font-size: 14px;
  margin-bottom: 16px;
}

.jp-Collab-comment-empty-help {
  text-align: left;
  font-size: 12px;
  background: var(--jp-layout-color2);
  padding: 12px;
  border-radius: 4px;
  max-width: 300px;
}

.jp-Collab-comment-empty-help ul {
  margin: 8px 0 0 0;
  padding-left: 16px;
}

.jp-Collab-comment-empty-help li {
  margin-bottom: 4px;
}

/* Individual comment thread */
.jp-Collab-comment-thread {
  margin-bottom: 16px;
  border: 1px solid var(--jp-border-color1);
  border-radius: 6px;
  overflow: hidden;
}

.jp-Collab-comment-thread.jp-Collab-comment-resolved {
  opacity: 0.7;
  border-color: var(--jp-success-color1);
}

.jp-Collab-comment-main {
  padding: 12px;
  background: var(--jp-layout-color1);
}

.jp-Collab-comment-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 8px;
}

.jp-Collab-comment-author {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.jp-Collab-comment-author-name {
  font-weight: 600;
  font-size: 12px;
  color: var(--jp-ui-font-color1);
}

.jp-Collab-comment-timestamp {
  font-size: 10px;
  color: var(--jp-ui-font-color2);
}

.jp-Collab-comment-edited {
  font-size: 10px;
  color: var(--jp-ui-font-color3);
  font-style: italic;
}

.jp-Collab-comment-actions {
  display: flex;
  gap: 4px;
}

.jp-Collab-comment-action-button {
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px;
  border-radius: 3px;
  font-size: 12px;
  transition: background 0.2s ease;
}

.jp-Collab-comment-action-button:hover {
  background: var(--jp-layout-color2);
}

.jp-Collab-comment-resolve {
  color: var(--jp-success-color1);
}

.jp-Collab-comment-delete {
  color: var(--jp-error-color1);
}

.jp-Collab-comment-content {
  margin-bottom: 8px;
}

.jp-Collab-comment-text {
  font-size: 13px;
  line-height: 1.4;
  color: var(--jp-ui-font-color1);
  white-space: pre-wrap;
  word-wrap: break-word;
}

/* Comment editing */
.jp-Collab-comment-edit-form {
  margin-bottom: 8px;
}

.jp-Collab-comment-edit-textarea {
  width: 100%;
  min-height: 60px;
  padding: 8px;
  border: 1px solid var(--jp-border-color1);
  border-radius: 4px;
  background: var(--jp-layout-color0);
  color: var(--jp-ui-font-color1);
  font-family: var(--jp-ui-font-family);
  font-size: 13px;
  resize: vertical;
  outline: none;
}

.jp-Collab-comment-edit-textarea:focus {
  border-color: var(--jp-brand-color1);
}

.jp-Collab-comment-edit-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.jp-Collab-comment-edit-save {
  background: var(--jp-brand-color1);
  color: white;
  border: none;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 11px;
  cursor: pointer;
}

.jp-Collab-comment-edit-save:hover:not(:disabled) {
  background: var(--jp-brand-color0);
}

.jp-Collab-comment-edit-save:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.jp-Collab-comment-edit-cancel {
  background: none;
  border: 1px solid var(--jp-border-color1);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--jp-ui-font-color1);
  cursor: pointer;
}

.jp-Collab-comment-edit-cancel:hover {
  background: var(--jp-layout-color2);
}

/* Comment anchor display */
.jp-Collab-comment-anchor {
  margin-bottom: 8px;
  padding: 6px;
  background: var(--jp-layout-color2);
  border-radius: 3px;
  border-left: 3px solid var(--jp-brand-color1);
}

.jp-Collab-comment-anchor-label {
  font-size: 10px;
  color: var(--jp-ui-font-color2);
  margin-bottom: 2px;
}

.jp-Collab-comment-anchor-text {
  font-size: 11px;
  font-style: italic;
  color: var(--jp-ui-font-color1);
}

/* Reply section */
.jp-Collab-comment-reply-section {
  border-top: 1px solid var(--jp-border-color1);
  padding-top: 8px;
}

.jp-Collab-comment-reply-button {
  background: none;
  border: none;
  color: var(--jp-brand-color1);
  cursor: pointer;
  font-size: 11px;
  text-decoration: underline;
}

.jp-Collab-comment-reply-button:hover {
  color: var(--jp-brand-color0);
}

.jp-Collab-comment-reply-form {
  margin-top: 8px;
}

.jp-Collab-comment-reply-textarea {
  width: 100%;
  min-height: 40px;
  padding: 6px;
  border: 1px solid var(--jp-border-color1);
  border-radius: 3px;
  background: var(--jp-layout-color0);
  color: var(--jp-ui-font-color1);
  font-family: var(--jp-ui-font-family);
  font-size: 12px;
  resize: vertical;
  outline: none;
}

.jp-Collab-comment-reply-textarea:focus {
  border-color: var(--jp-brand-color1);
}

.jp-Collab-comment-reply-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.jp-Collab-comment-reply-post {
  background: var(--jp-brand-color1);
  color: white;
  border: none;
  border-radius: 3px;
  padding: 4px 8px;
  font-size: 11px;
  cursor: pointer;
}

.jp-Collab-comment-reply-post:hover:not(:disabled) {
  background: var(--jp-brand-color0);
}

.jp-Collab-comment-reply-post:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.jp-Collab-comment-reply-cancel {
  background: none;
  border: 1px solid var(--jp-border-color1);
  border-radius: 3px;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--jp-ui-font-color1);
  cursor: pointer;
}

.jp-Collab-comment-reply-cancel:hover {
  background: var(--jp-layout-color2);
}

/* Replies section */
.jp-Collab-comment-replies {
  border-top: 1px solid var(--jp-border-color1);
  background: var(--jp-layout-color0);
}

.jp-Collab-comment-replies-header {
  padding: 8px 12px;
  background: var(--jp-layout-color2);
}

.jp-Collab-comment-replies-toggle {
  background: none;
  border: none;
  color: var(--jp-ui-font-color2);
  cursor: pointer;
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.jp-Collab-comment-replies-toggle:hover {
  color: var(--jp-ui-font-color1);
}

.jp-Collab-comment-replies-list {
  padding: 0 12px 8px;
}

.jp-Collab-comment-replies-list .jp-Collab-comment-thread {
  margin-bottom: 8px;
  border: none;
  border-left: 2px solid var(--jp-border-color1);
  border-radius: 0;
  background: var(--jp-layout-color1);
  padding-left: 8px;
}

/* Animations */
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

/* Responsive design */
@media (max-width: 768px) {
  .jp-Collab-comment-panel {
    width: 100vw;
    height: 100vh;
    top: 0;
    right: 0;
    border-radius: 0;
    max-width: none;
    max-height: none;
  }
  
  .jp-Collab-comment-panel-controls {
    flex-direction: column;
    gap: 8px;
    align-items: flex-start;
  }
}

/* High contrast mode support */
@media (prefers-contrast: high) {
  .jp-Collab-comment-indicator {
    border: 2px solid currentColor;
  }
  
  .jp-Collab-comment-panel {
    border: 2px solid var(--jp-border-color1);
  }
  
  .jp-Collab-comment-thread {
    border: 2px solid var(--jp-border-color1);
  }
}

/* Dark theme adjustments */
@media (prefers-color-scheme: dark) {
  .jp-Collab-comment-panel {
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }
}
`;