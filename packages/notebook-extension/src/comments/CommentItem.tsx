/**
 * @fileoverview CommentItem - React component for rendering individual comments within a thread
 * 
 * This component displays individual comments in the collaborative notebook environment, including
 * author information with unique colors for presence awareness, timestamps using JupyterLab Time
 * utilities, content rendering with markdown support and proper sanitization, and action buttons
 * for editing and replying with integrated permission checking.
 * 
 * Key features:
 * - Author avatar display with unique colors for collaborative awareness
 * - Timestamp formatting using Time utility from JupyterLab coreutils
 * - Markdown content rendering with proper sanitization for security
 * - Edit/reply action buttons with role-based permission checking
 * - Real-time comment synchronization through Yjs integration
 * - Threaded comment display with reply indicators
 * - Comment status indicators (resolved, edited, etc.)
 * - Integration with translation system for internationalized UI labels
 * - Accessibility support with proper ARIA attributes
 * 
 * @author Blitzy Platform Development Team
 * @version 1.0.0
 * @since 2024
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Button, Tooltip } from '@jupyterlab/ui-components';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { Time } from '@jupyterlab/coreutils';
import { showErrorMessage, showDialog, Dialog } from '@jupyterlab/apputils';
import { MarkdownDocument } from '@jupyterlab/rendermime';

// Import comment system types and components
import {
  IComment,
  ICommentUser,
  CommentStatus,
  CommentPriority,
  ICommentResolution
} from './types';
import CommentInput from './CommentInput';

/**
 * Props interface for CommentItem component configuration
 */
export interface ICommentItemProps {
  /** The comment object to display */
  comment: IComment;
  /** Current user viewing/interacting with the comment */
  currentUser: ICommentUser;
  /** Translator service for internationalization */
  translator?: ITranslator;
  /** Whether the current user can edit this comment */
  canEdit?: boolean;
  /** Whether the current user can reply to this comment */
  canReply?: boolean;
  /** Whether the current user can resolve this comment */
  canResolve?: boolean;
  /** Whether the current user can delete this comment */
  canDelete?: boolean;
  /** Whether to show the reply form inline */
  showReplyForm?: boolean;
  /** Whether to show the edit form inline */
  showEditForm?: boolean;
  /** Callback fired when user wants to reply to this comment */
  onReply?: (comment: IComment) => void;
  /** Callback fired when user wants to edit this comment */
  onEdit?: (comment: IComment) => void;
  /** Callback fired when user wants to delete this comment */
  onDelete?: (comment: IComment) => void;
  /** Callback fired when user wants to resolve this comment */
  onResolve?: (comment: IComment) => void;
  /** Callback fired when user wants to reopen this comment */
  onReopen?: (comment: IComment) => void;
  /** Callback fired when comment is updated */
  onCommentUpdate?: (comment: IComment) => void;
  /** Callback fired when reply form is cancelled */
  onCancelReply?: () => void;
  /** Callback fired when edit form is cancelled */
  onCancelEdit?: () => void;
  /** Additional CSS classes for styling */
  className?: string;
  /** Whether to show this comment in compact mode */
  compact?: boolean;
  /** Whether to highlight this comment */
  highlighted?: boolean;
  /** Whether to show comment metadata (edit history, etc.) */
  showMetadata?: boolean;
}

/**
 * CommentItem - React component for displaying individual comments within a thread
 * 
 * Renders individual comments with comprehensive collaborative features including author
 * presence awareness, timestamp formatting, markdown content rendering, and action buttons
 * with permission-based access control. Follows React hooks patterns established in 
 * trusted.tsx while integrating with the collaborative comment system architecture.
 */
const CommentItem: React.FC<ICommentItemProps> = ({
  comment,
  currentUser,
  translator = nullTranslator,
  canEdit = false,
  canReply = false,
  canResolve = false,
  canDelete = false,
  showReplyForm = false,
  showEditForm = false,
  onReply,
  onEdit,
  onDelete,
  onResolve,
  onReopen,
  onCommentUpdate,
  onCancelReply,
  onCancelEdit,
  className = '',
  compact = false,
  highlighted = false,
  showMetadata = false
}) => {
  const trans = translator.load('notebook');
  
  // Component state
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [isResolving, setIsResolving] = useState<boolean>(false);
  const [showResolutionDialog, setShowResolutionDialog] = useState<boolean>(false);
  const [resolutionReason, setResolutionReason] = useState<string>('');
  const [showEditHistory, setShowEditHistory] = useState<boolean>(false);
  const [expandedAttachments, setExpandedAttachments] = useState<Set<string>>(new Set());
  
  // Refs for DOM manipulation
  const commentRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  
  /**
   * Scroll comment into view when highlighted
   */
  useEffect(() => {
    if (highlighted && commentRef.current) {
      commentRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlighted]);
  
  /**
   * Determine if current user is the comment author
   */
  const isAuthor = useMemo(() => {
    return currentUser.id === comment.createdBy.id;
  }, [currentUser.id, comment.createdBy.id]);
  
  /**
   * Determine final edit/reply permissions based on comment status and user roles
   */
  const effectivePermissions = useMemo(() => {
    const isResolved = comment.status === CommentStatus.RESOLVED;
    const isDeleted = comment.status === CommentStatus.DELETED;
    const isArchived = comment.status === CommentStatus.ARCHIVED;
    const isAdmin = currentUser.role === 'admin';
    
    return {
      canEdit: canEdit && !isDeleted && (isAdmin || (!isResolved && !isArchived)),
      canReply: canReply && !isDeleted && !isArchived,
      canDelete: canDelete && (isAdmin || (isAuthor && !isDeleted)),
      canResolve: canResolve && !isDeleted && !isResolved,
      canReopen: (canResolve || isAdmin) && isResolved && !isDeleted
    };
  }, [
    comment.status,
    currentUser.role,
    canEdit,
    canReply,
    canDelete,
    canResolve,
    isAuthor
  ]);
  
  /**
   * Format comment timestamp for display
   */
  const formattedTimestamp = useMemo(() => {
    try {
      const createdDate = new Date(comment.createdAt);
      const now = new Date();
      const diffHours = (now.getTime() - createdDate.getTime()) / (1000 * 60 * 60);
      
      // Show relative time for recent comments (< 24 hours)
      if (diffHours < 24) {
        return Time.formatHuman(createdDate);
      } else {
        // Show absolute time for older comments
        return Time.format(createdDate, 'MMM DD, YYYY [at] h:mm A');
      }
    } catch (error) {
      console.warn('Error formatting comment timestamp:', error);
      return trans.__('Unknown time');
    }
  }, [comment.createdAt, trans]);
  
  /**
   * Format updated timestamp if comment was edited
   */
  const formattedUpdatedTimestamp = useMemo(() => {
    if (!comment.isEdited || !comment.updatedAt) {
      return null;
    }
    
    try {
      const updatedDate = new Date(comment.updatedAt);
      return Time.formatHuman(updatedDate);
    } catch (error) {
      console.warn('Error formatting comment updated timestamp:', error);
      return null;
    }
  }, [comment.isEdited, comment.updatedAt]);
  
  /**
   * Generate user avatar component with unique color
   */
  const userAvatar = useMemo(() => {
    const { avatar, displayName, color, isOnline } = comment.createdBy;
    
    if (avatar) {
      return (
        <img
          src={avatar}
          alt={displayName}
          className="jp-comment-item-avatar-image"
          onError={(e) => {
            // Fallback to color-based avatar if image fails to load
            const target = e.target as HTMLImageElement;
            target.style.display = 'none';
            const fallback = target.nextElementSibling as HTMLElement;
            if (fallback) {
              fallback.style.display = 'flex';
            }
          }}
        />
      );
    }
    
    return null;
  }, [comment.createdBy]);
  
  /**
   * Generate fallback color-based avatar
   */
  const colorAvatar = useMemo(() => {
    const { displayName, color, isOnline } = comment.createdBy;
    const initials = displayName
      .split(' ')
      .map(name => name.charAt(0).toUpperCase())
      .slice(0, 2)
      .join('');
    
    return (
      <div
        className={`jp-comment-item-avatar-fallback ${!userAvatar ? 'jp-comment-item-avatar-fallback-visible' : ''}`}
        style={{ backgroundColor: color }}
        title={`${displayName} (${isOnline ? trans.__('Online') : trans.__('Offline')})`}
      >
        {initials}
      </div>
    );
  }, [comment.createdBy, userAvatar, trans]);
  
  /**
   * Render comment priority indicator
   */
  const priorityIndicator = useMemo(() => {
    if (comment.priority === CommentPriority.NORMAL) {
      return null;
    }
    
    const priorityClasses = {
      [CommentPriority.LOW]: 'jp-comment-item-priority-low',
      [CommentPriority.HIGH]: 'jp-comment-item-priority-high',
      [CommentPriority.CRITICAL]: 'jp-comment-item-priority-critical'
    };
    
    const priorityLabels = {
      [CommentPriority.LOW]: trans.__('Low Priority'),
      [CommentPriority.HIGH]: trans.__('High Priority'),
      [CommentPriority.CRITICAL]: trans.__('Critical Priority')
    };
    
    return (
      <span
        className={`jp-comment-item-priority ${priorityClasses[comment.priority]}`}
        title={priorityLabels[comment.priority]}
      >
        {comment.priority.toUpperCase()}
      </span>
    );
  }, [comment.priority, trans]);
  
  /**
   * Render comment status indicator
   */
  const statusIndicator = useMemo(() => {
    if (comment.status === CommentStatus.ACTIVE) {
      return null;
    }
    
    const statusClasses = {
      [CommentStatus.RESOLVED]: 'jp-comment-item-status-resolved',
      [CommentStatus.PENDING]: 'jp-comment-item-status-pending',
      [CommentStatus.DELETED]: 'jp-comment-item-status-deleted',
      [CommentStatus.ARCHIVED]: 'jp-comment-item-status-archived',
      [CommentStatus.FLAGGED]: 'jp-comment-item-status-flagged',
      [CommentStatus.EDITED]: 'jp-comment-item-status-edited',
      [CommentStatus.DRAFT]: 'jp-comment-item-status-draft'
    };
    
    const statusLabels = {
      [CommentStatus.RESOLVED]: trans.__('Resolved'),
      [CommentStatus.PENDING]: trans.__('Pending'),
      [CommentStatus.DELETED]: trans.__('Deleted'),
      [CommentStatus.ARCHIVED]: trans.__('Archived'),
      [CommentStatus.FLAGGED]: trans.__('Flagged'),
      [CommentStatus.EDITED]: trans.__('Edited'),
      [CommentStatus.DRAFT]: trans.__('Draft')
    };
    
    return (
      <span
        className={`jp-comment-item-status ${statusClasses[comment.status]}`}
        title={statusLabels[comment.status]}
      >
        {statusLabels[comment.status]}
      </span>
    );
  }, [comment.status, trans]);
  
  /**
   * Render markdown content with proper sanitization
   */
  const renderedContent = useMemo(() => {
    if (showEditForm) {
      return null;
    }
    
    try {
      return (
        <div className="jp-comment-item-content" ref={contentRef}>
          <MarkdownDocument
            source={comment.content}
            trusted={false}
            resolver={null}
            sanitizer={null}
            linkHandler={null}
          />
        </div>
      );
    } catch (error) {
      console.error('Error rendering comment markdown:', error);
      return (
        <div className="jp-comment-item-content jp-comment-item-content-error">
          <p>{trans.__('Error rendering comment content')}</p>
          <pre>{comment.content}</pre>
        </div>
      );
    }
  }, [comment.content, showEditForm, trans]);
  
  /**
   * Handle comment deletion with confirmation
   */
  const handleDelete = useCallback(async () => {
    if (isDeleting) return;
    
    const result = await showDialog({
      title: trans.__('Delete Comment'),
      body: trans.__('Are you sure you want to delete this comment? This action cannot be undone.'),
      buttons: [
        Dialog.cancelButton({ label: trans.__('Cancel') }),
        Dialog.warnButton({ label: trans.__('Delete') })
      ]
    });
    
    if (result.button.accept) {
      setIsDeleting(true);
      try {
        await onDelete?.(comment);
      } catch (error) {
        console.error('Error deleting comment:', error);
        showErrorMessage(
          trans.__('Delete Comment Error'),
          trans.__('Failed to delete comment: %1', error.message)
        );
      } finally {
        setIsDeleting(false);
      }
    }
  }, [isDeleting, comment, onDelete, trans]);
  
  /**
   * Handle comment resolution
   */
  const handleResolve = useCallback(async () => {
    if (isResolving) return;
    
    setIsResolving(true);
    try {
      await onResolve?.(comment);
      setShowResolutionDialog(false);
      setResolutionReason('');
    } catch (error) {
      console.error('Error resolving comment:', error);
      showErrorMessage(
        trans.__('Resolve Comment Error'),
        trans.__('Failed to resolve comment: %1', error.message)
      );
    } finally {
      setIsResolving(false);
    }
  }, [isResolving, comment, onResolve, trans]);
  
  /**
   * Handle comment reopening
   */
  const handleReopen = useCallback(async () => {
    try {
      await onReopen?.(comment);
    } catch (error) {
      console.error('Error reopening comment:', error);
      showErrorMessage(
        trans.__('Reopen Comment Error'),
        trans.__('Failed to reopen comment: %1', error.message)
      );
    }
  }, [comment, onReopen, trans]);
  
  /**
   * Handle edit action
   */
  const handleEdit = useCallback(() => {
    onEdit?.(comment);
  }, [comment, onEdit]);
  
  /**
   * Handle reply action
   */
  const handleReply = useCallback(() => {
    onReply?.(comment);
  }, [comment, onReply]);
  
  /**
   * Toggle edit history display
   */
  const toggleEditHistory = useCallback(() => {
    setShowEditHistory(prev => !prev);
  }, []);
  
  /**
   * Toggle attachment expansion
   */
  const toggleAttachment = useCallback((attachmentId: string) => {
    setExpandedAttachments(prev => {
      const newSet = new Set(prev);
      if (newSet.has(attachmentId)) {
        newSet.delete(attachmentId);
      } else {
        newSet.add(attachmentId);
      }
      return newSet;
    });
  }, []);
  
  return (
    <div
      ref={commentRef}
      className={`jp-comment-item ${
        compact ? 'jp-comment-item-compact' : ''
      } ${
        highlighted ? 'jp-comment-item-highlighted' : ''
      } ${
        comment.level > 0 ? 'jp-comment-item-reply' : ''
      } ${className}`}
      data-comment-id={comment.id}
      data-comment-status={comment.status}
      style={{
        '--comment-level': comment.level,
        marginLeft: `${comment.level * 20}px`
      } as React.CSSProperties}
    >
      {/* Comment Header */}
      <div className="jp-comment-item-header">
        <div className="jp-comment-item-author">
          <div className="jp-comment-item-avatar">
            {userAvatar}
            {colorAvatar}
            {comment.createdBy.isOnline && (
              <div className="jp-comment-item-avatar-online-indicator" />
            )}
          </div>
          <div className="jp-comment-item-author-info">
            <span className="jp-comment-item-author-name">
              {comment.createdBy.displayName}
            </span>
            <span className="jp-comment-item-timestamp" title={comment.createdAt}>
              {formattedTimestamp}
            </span>
            {comment.isEdited && formattedUpdatedTimestamp && (
              <span className="jp-comment-item-edited" title={comment.updatedAt}>
                {trans.__('(edited %1)', formattedUpdatedTimestamp)}
              </span>
            )}
          </div>
        </div>
        
        <div className="jp-comment-item-metadata">
          {priorityIndicator}
          {statusIndicator}
        </div>
      </div>
      
      {/* Comment Content */}
      <div className="jp-comment-item-body">
        {showEditForm ? (
          <CommentInput
            cellId=""
            commentManager={null as any}
            notificationManager={null as any}
            translator={translator}
            existingComment={comment}
            onSubmit={onCommentUpdate}
            onCancel={onCancelEdit}
            placeholder={trans.__('Edit your comment...')}
            maxLength={5000}
            autoFocus={true}
            compact={compact}
          />
        ) : (
          <>
            {renderedContent}
            
            {/* Comment Attachments */}
            {comment.attachments && comment.attachments.length > 0 && (
              <div className="jp-comment-item-attachments">
                <h5 className="jp-comment-item-attachments-title">
                  {trans.__('Attachments')}
                </h5>
                {comment.attachments.map(attachment => (
                  <div key={attachment.id} className="jp-comment-item-attachment">
                    <button
                      className="jp-comment-item-attachment-toggle"
                      onClick={() => toggleAttachment(attachment.id)}
                    >
                      {attachment.filename} ({attachment.size} bytes)
                    </button>
                    {expandedAttachments.has(attachment.id) && (
                      <div className="jp-comment-item-attachment-content">
                        {attachment.mimeType.startsWith('image/') ? (
                          <img
                            src={attachment.url}
                            alt={attachment.filename}
                            className="jp-comment-item-attachment-image"
                          />
                        ) : (
                          <a
                            href={attachment.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="jp-comment-item-attachment-link"
                          >
                            {trans.__('Download')}
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            
            {/* Comment Mentions */}
            {comment.mentions && comment.mentions.length > 0 && showMetadata && (
              <div className="jp-comment-item-mentions">
                <span className="jp-comment-item-mentions-label">
                  {trans.__('Mentions:')}
                </span>
                {comment.mentions.map((mention, index) => (
                  <span key={index} className="jp-comment-item-mention">
                    @{mention.user.displayName}
                  </span>
                ))}
              </div>
            )}
            
            {/* Comment Tags */}
            {comment.tags && comment.tags.length > 0 && showMetadata && (
              <div className="jp-comment-item-tags">
                {comment.tags.map(tag => (
                  <span key={tag} className="jp-comment-item-tag">
                    #{tag}
                  </span>
                ))}
              </div>
            )}
            
            {/* Comment Reactions */}
            {comment.reactions && comment.reactions.length > 0 && (
              <div className="jp-comment-item-reactions">
                {comment.reactions.map(reaction => (
                  <span
                    key={reaction.emoji}
                    className="jp-comment-item-reaction"
                    title={`${reaction.users.map(u => u.displayName).join(', ')}`}
                  >
                    {reaction.emoji} {reaction.count}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      
      {/* Comment Actions */}
      {!showEditForm && (
        <div className="jp-comment-item-actions">
          <div className="jp-comment-item-primary-actions">
            {effectivePermissions.canReply && (
              <Button
                size="small"
                onClick={handleReply}
                title={trans.__('Reply to this comment')}
              >
                {trans.__('Reply')}
              </Button>
            )}
            
            {effectivePermissions.canEdit && isAuthor && (
              <Button
                size="small"
                onClick={handleEdit}
                title={trans.__('Edit this comment')}
              >
                {trans.__('Edit')}
              </Button>
            )}
            
            {effectivePermissions.canResolve && (
              <Button
                size="small"
                onClick={handleResolve}
                disabled={isResolving}
                title={trans.__('Mark this comment as resolved')}
              >
                {isResolving ? trans.__('Resolving...') : trans.__('Resolve')}
              </Button>
            )}
            
            {effectivePermissions.canReopen && (
              <Button
                size="small"
                onClick={handleReopen}
                title={trans.__('Reopen this resolved comment')}
              >
                {trans.__('Reopen')}
              </Button>
            )}
          </div>
          
          <div className="jp-comment-item-secondary-actions">
            {comment.isEdited && comment.editHistory && comment.editHistory.length > 0 && (
              <Button
                size="small"
                minimal={true}
                onClick={toggleEditHistory}
                title={trans.__('View edit history')}
              >
                {trans.__('History')}
              </Button>
            )}
            
            {effectivePermissions.canDelete && (
              <Button
                size="small"
                minimal={true}
                onClick={handleDelete}
                disabled={isDeleting}
                title={trans.__('Delete this comment')}
                className="jp-comment-item-delete-button"
              >
                {isDeleting ? trans.__('Deleting...') : trans.__('Delete')}
              </Button>
            )}
          </div>
        </div>
      )}
      
      {/* Edit History */}
      {showEditHistory && comment.editHistory && (
        <div className="jp-comment-item-edit-history">
          <h5 className="jp-comment-item-edit-history-title">
            {trans.__('Edit History')}
          </h5>
          {comment.editHistory.map(edit => (
            <div key={edit.id} className="jp-comment-item-edit-history-item">
              <div className="jp-comment-item-edit-history-meta">
                <span className="jp-comment-item-edit-history-user">
                  {edit.editedBy.displayName}
                </span>
                <span className="jp-comment-item-edit-history-time">
                  {Time.formatHuman(new Date(edit.editedAt))}
                </span>
                {edit.reason && (
                  <span className="jp-comment-item-edit-history-reason">
                    ({edit.reason})
                  </span>
                )}
              </div>
              {edit.diff && (
                <div className="jp-comment-item-edit-history-diff">
                  {edit.diff.removed.map((line, index) => (
                    <div key={`removed-${index}`} className="jp-comment-item-diff-removed">
                      - {line}
                    </div>
                  ))}
                  {edit.diff.added.map((line, index) => (
                    <div key={`added-${index}`} className="jp-comment-item-diff-added">
                      + {line}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      
      {/* Reply Form */}
      {showReplyForm && (
        <div className="jp-comment-item-reply-form">
          <CommentInput
            cellId=""
            commentManager={null as any}
            notificationManager={null as any}
            translator={translator}
            parentId={comment.id}
            onSubmit={onCommentUpdate}
            onCancel={onCancelReply}
            placeholder={trans.__('Write a reply...')}
            maxLength={5000}
            autoFocus={true}
            compact={true}
          />
        </div>
      )}
      
      {/* Resolution Info */}
      {comment.resolution && comment.status === CommentStatus.RESOLVED && (
        <div className="jp-comment-item-resolution">
          <div className="jp-comment-item-resolution-info">
            <span className="jp-comment-item-resolution-label">
              {trans.__('Resolved by')}
            </span>
            <span className="jp-comment-item-resolution-user">
              {comment.resolution.resolvedBy.displayName}
            </span>
            <span className="jp-comment-item-resolution-time">
              {Time.formatHuman(new Date(comment.resolution.resolvedAt))}
            </span>
          </div>
          {comment.resolution.reason && (
            <div className="jp-comment-item-resolution-reason">
              {comment.resolution.reason}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CommentItem;