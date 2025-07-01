/**
 * @fileoverview CommentInput - React component for creating and editing collaborative comments
 * 
 * This component provides a rich text input interface for creating new comments and editing
 * existing ones in the collaborative notebook environment. Features include markdown support,
 * live preview functionality, @mention capabilities, and real-time synchronization through
 * the Yjs-based CommentManager system.
 * 
 * Key features:
 * - Markdown-enabled text area with live preview toggle
 * - @mention functionality for user notifications
 * - Submit/cancel controls with keyboard shortcuts (Ctrl+Enter, Escape)
 * - Input validation and error handling
 * - Integration with CommentManager for Yjs Y.Array operations
 * - Real-time comment synchronization (≤100ms latency per F-028)
 * - Responsive design adapting to notebook cell layout
 * 
 * @author Blitzy Platform Development Team
 * @version 1.0.0
 * @since 2024
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Button } from '@jupyterlab/ui-components';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { showErrorMessage } from '@jupyterlab/apputils';
import { Tooltip } from '@jupyterlab/tooltip';
import { MarkdownDocument } from '@jupyterlab/rendermime';

// Import comment system types and managers
import {
  IComment,
  ICommentUser,
  CreateCommentPayload,
  CommentStatus,
  CommentPriority,
  ICommentMention
} from './types';
import { CommentManager } from './CommentManager';
import { CommentNotificationManager } from './notifications';

/**
 * Props interface for CommentInput component configuration
 */
export interface ICommentInputProps {
  /** ID of the notebook cell to attach comment to */
  cellId: string;
  /** CommentManager instance for Yjs operations */
  commentManager: CommentManager;
  /** Notification manager for @mention and activity alerts */
  notificationManager: CommentNotificationManager;
  /** Translator service for internationalization */
  translator?: ITranslator;
  /** Existing comment to edit (null for new comment creation) */
  existingComment?: IComment | null;
  /** Parent comment ID for threaded replies */
  parentId?: string | null;
  /** Callback fired when comment is successfully submitted */
  onSubmit?: (comment: IComment) => void;
  /** Callback fired when input is cancelled */
  onCancel?: () => void;
  /** Callback fired when input focus changes */
  onFocusChange?: (focused: boolean) => void;
  /** Placeholder text for the input area */
  placeholder?: string;
  /** Whether to show markdown preview by default */
  defaultPreview?: boolean;
  /** Maximum character limit for comments */
  maxLength?: number;
  /** Whether to auto-focus the input on mount */
  autoFocus?: boolean;
  /** Additional CSS classes for styling */
  className?: string;
  /** Whether the input is in compact mode */
  compact?: boolean;
  /** List of available users for @mention autocomplete */
  availableUsers?: ICommentUser[];
}

/**
 * Interface for @mention autocomplete suggestion
 */
interface IMentionSuggestion {
  user: ICommentUser;
  matchStart: number;
  matchEnd: number;
  displayText: string;
}

/**
 * Interface for input validation result
 */
interface IValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * CommentInput - React component for collaborative comment creation and editing
 * 
 * Provides a rich text input interface with markdown support, @mention functionality,
 * and real-time synchronization through the CommentManager. Follows the React hooks
 * pattern established in trusted.tsx while integrating with the collaborative
 * comment system architecture.
 */
const CommentInput: React.FC<ICommentInputProps> = ({
  cellId,
  commentManager,
  notificationManager,
  translator = nullTranslator,
  existingComment = null,
  parentId = null,
  onSubmit,
  onCancel,
  onFocusChange,
  placeholder,
  defaultPreview = false,
  maxLength = 5000,
  autoFocus = false,
  className = '',
  compact = false,
  availableUsers = []
}) => {
  const trans = translator.load('notebook');
  
  // Core state management
  const [content, setContent] = useState<string>(existingComment?.content || '');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [showPreview, setShowPreview] = useState<boolean>(defaultPreview);
  const [isFocused, setIsFocused] = useState<boolean>(false);
  const [validationResult, setValidationResult] = useState<IValidationResult>({
    isValid: true,
    errors: [],
    warnings: []
  });
  
  // @mention functionality state
  const [showMentionSuggestions, setShowMentionSuggestions] = useState<boolean>(false);
  const [mentionSuggestions, setMentionSuggestions] = useState<IMentionSuggestion[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState<number>(0);
  const [currentMentionQuery, setCurrentMentionQuery] = useState<string>('');
  const [mentionStartPosition, setMentionStartPosition] = useState<number>(-1);
  
  // Refs for DOM manipulation
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Debounced validation timer
  const validationTimerRef = useRef<NodeJS.Timeout | null>(null);
  
  /**
   * Auto-focus textarea on mount if requested
   */
  useEffect(() => {
    if (autoFocus && textAreaRef.current) {
      textAreaRef.current.focus();
    }
  }, [autoFocus]);
  
  /**
   * Notify parent component of focus changes
   */
  useEffect(() => {
    onFocusChange?.(isFocused);
  }, [isFocused, onFocusChange]);
  
  /**
   * Set up keyboard event listeners for global shortcuts
   */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Only handle events when this component is focused
      if (!isFocused) return;
      
      // Ctrl+Enter or Cmd+Enter: Submit comment
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        handleSubmit();
      }
      
      // Escape: Cancel editing
      if (event.key === 'Escape' && !showMentionSuggestions) {
        event.preventDefault();
        handleCancel();
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isFocused, showMentionSuggestions]);
  
  /**
   * Validate comment content with debouncing
   */
  const validateContent = useCallback((text: string): IValidationResult => {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // Check minimum content requirement
    if (!text.trim()) {
      errors.push(trans.__('Comment content cannot be empty'));
    }
    
    // Check maximum length
    if (text.length > maxLength) {
      errors.push(trans.__('Comment exceeds maximum length of %1 characters', maxLength));
    }
    
    // Check for potentially problematic content
    if (text.length > maxLength * 0.9) {
      warnings.push(trans.__('Comment is approaching maximum length'));
    }
    
    // Validate @mention syntax
    const mentionRegex = /@(\w+)/g;
    let match;
    while ((match = mentionRegex.exec(text)) !== null) {
      const mentionedUsername = match[1];
      const userExists = availableUsers.some(user => 
        user.username === mentionedUsername || user.displayName === mentionedUsername
      );
      
      if (!userExists) {
        warnings.push(trans.__('User @%1 not found - mention may not deliver notification', mentionedUsername));
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }, [maxLength, availableUsers, trans]);
  
  /**
   * Debounced content validation
   */
  useEffect(() => {
    if (validationTimerRef.current) {
      clearTimeout(validationTimerRef.current);
    }
    
    validationTimerRef.current = setTimeout(() => {
      const result = validateContent(content);
      setValidationResult(result);
    }, 300);
    
    return () => {
      if (validationTimerRef.current) {
        clearTimeout(validationTimerRef.current);
      }
    };
  }, [content, validateContent]);
  
  /**
   * Extract @mentions from comment content
   */
  const extractMentions = useCallback((text: string): ICommentMention[] => {
    const mentions: ICommentMention[] = [];
    const mentionRegex = /@(\w+)/g;
    let match;
    
    while ((match = mentionRegex.exec(text)) !== null) {
      const mentionedUsername = match[1];
      const user = availableUsers.find(u => 
        u.username === mentionedUsername || u.displayName === mentionedUsername
      );
      
      if (user) {
        mentions.push({
          user,
          position: {
            start: match.index,
            end: match.index + match[0].length
          },
          delivered: false,
          type: 'USER' as any // CommentMentionType.USER
        });
      }
    }
    
    return mentions;
  }, [availableUsers]);
  
  /**
   * Handle @mention autocomplete functionality
   */
  const handleMentionDetection = useCallback((text: string, cursorPosition: number) => {
    // Find if cursor is within or after an @mention
    const beforeCursor = text.substring(0, cursorPosition);
    const mentionMatch = beforeCursor.match(/@(\w*)$/);
    
    if (mentionMatch) {
      const query = mentionMatch[1];
      const startPos = cursorPosition - mentionMatch[0].length;
      
      setCurrentMentionQuery(query);
      setMentionStartPosition(startPos);
      
      // Filter users based on query
      const filtered = availableUsers
        .filter(user => 
          user.displayName.toLowerCase().includes(query.toLowerCase()) ||
          user.username.toLowerCase().includes(query.toLowerCase())
        )
        .slice(0, 10) // Limit to 10 suggestions
        .map(user => ({
          user,
          matchStart: startPos,
          matchEnd: cursorPosition,
          displayText: user.displayName
        }));
      
      setMentionSuggestions(filtered);
      setShowMentionSuggestions(filtered.length > 0);
      setSelectedSuggestionIndex(0);
    } else {
      setShowMentionSuggestions(false);
      setMentionSuggestions([]);
      setCurrentMentionQuery('');
      setMentionStartPosition(-1);
    }
  }, [availableUsers]);
  
  /**
   * Handle text area content changes
   */
  const handleContentChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = event.target.value;
    const cursorPosition = event.target.selectionStart;
    
    setContent(newContent);
    
    // Check for @mention detection
    handleMentionDetection(newContent, cursorPosition);
  }, [handleMentionDetection]);
  
  /**
   * Handle textarea focus events
   */
  const handleFocus = useCallback(() => {
    setIsFocused(true);
  }, []);
  
  /**
   * Handle textarea blur events
   */
  const handleBlur = useCallback(() => {
    // Delay blur to allow mention selection clicks
    setTimeout(() => {
      setIsFocused(false);
      setShowMentionSuggestions(false);
    }, 150);
  }, []);
  
  /**
   * Handle @mention suggestion selection
   */
  const selectMentionSuggestion = useCallback((suggestion: IMentionSuggestion) => {
    if (!textAreaRef.current) return;
    
    const beforeMention = content.substring(0, mentionStartPosition);
    const afterMention = content.substring(suggestion.matchEnd);
    const mentionText = `@${suggestion.user.username}`;
    
    const newContent = beforeMention + mentionText + afterMention;
    const newCursorPosition = mentionStartPosition + mentionText.length;
    
    setContent(newContent);
    setShowMentionSuggestions(false);
    
    // Restore cursor position
    setTimeout(() => {
      if (textAreaRef.current) {
        textAreaRef.current.focus();
        textAreaRef.current.setSelectionRange(newCursorPosition, newCursorPosition);
      }
    }, 0);
  }, [content, mentionStartPosition]);
  
  /**
   * Handle keyboard navigation in mention suggestions
   */
  const handleMentionKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (!showMentionSuggestions) return;
    
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setSelectedSuggestionIndex(prev => 
          prev < mentionSuggestions.length - 1 ? prev + 1 : 0
        );
        break;
        
      case 'ArrowUp':
        event.preventDefault();
        setSelectedSuggestionIndex(prev => 
          prev > 0 ? prev - 1 : mentionSuggestions.length - 1
        );
        break;
        
      case 'Enter':
      case 'Tab':
        event.preventDefault();
        if (mentionSuggestions[selectedSuggestionIndex]) {
          selectMentionSuggestion(mentionSuggestions[selectedSuggestionIndex]);
        }
        break;
        
      case 'Escape':
        event.preventDefault();
        setShowMentionSuggestions(false);
        break;
    }
  }, [showMentionSuggestions, mentionSuggestions, selectedSuggestionIndex, selectMentionSuggestion]);
  
  /**
   * Handle comment submission with validation and Yjs integration
   */
  const handleSubmit = useCallback(async () => {
    if (isSubmitting) return;
    
    const validation = validateContent(content);
    if (!validation.isValid) {
      showErrorMessage(
        trans.__('Comment Validation Error'),
        validation.errors.join('\n')
      );
      return;
    }
    
    setIsSubmitting(true);
    
    try {
      let comment: IComment;
      
      if (existingComment) {
        // Update existing comment
        comment = await commentManager.updateComment(existingComment.id, content);
      } else {
        // Create new comment
        comment = await commentManager.createComment(cellId, content, parentId);
      }
      
      // Process @mentions and create notifications
      const mentions = extractMentions(content);
      if (mentions.length > 0) {
        for (const mention of mentions) {
          await notificationManager.createMentionNotification({
            cellId,
            commentId: comment.id,
            authorId: commentManager.currentUser.id,
            authorName: commentManager.currentUser.displayName,
            targetUserId: mention.user.id,
            mentionContext: content.substring(
              Math.max(0, mention.position.start - 20),
              Math.min(content.length, mention.position.end + 20)
            ),
            mentionPosition: mention.position.start,
            isDirect: true,
            metadata: {
              commentContent: content,
              cellId
            }
          });
        }
      }
      
      // Clear input and notify parent
      setContent('');
      setValidationResult({ isValid: true, errors: [], warnings: [] });
      onSubmit?.(comment);
      
    } catch (error) {
      console.error('Error submitting comment:', error);
      showErrorMessage(
        trans.__('Comment Submission Error'),
        trans.__('Failed to submit comment: %1', error.message)
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [
    isSubmitting,
    content,
    validateContent,
    existingComment,
    commentManager,
    cellId,
    parentId,
    extractMentions,
    notificationManager,
    onSubmit,
    trans
  ]);
  
  /**
   * Handle comment cancellation
   */
  const handleCancel = useCallback(() => {
    setContent(existingComment?.content || '');
    setValidationResult({ isValid: true, errors: [], warnings: [] });
    setShowMentionSuggestions(false);
    onCancel?.();
  }, [existingComment, onCancel]);
  
  /**
   * Toggle markdown preview mode
   */
  const togglePreview = useCallback(() => {
    setShowPreview(prev => !prev);
  }, []);
  
  /**
   * Render markdown preview content
   */
  const renderPreview = useMemo(() => {
    if (!showPreview || !content.trim()) return null;
    
    try {
      return (
        <div className="jp-comment-input-preview">
          <MarkdownDocument
            source={content}
            trusted={false}
            resolver={null}
            sanitizer={null}
            linkHandler={null}
          />
        </div>
      );
    } catch (error) {
      return (
        <div className="jp-comment-input-preview-error">
          {trans.__('Preview error: Invalid markdown')}
        </div>
      );
    }
  }, [showPreview, content, trans]);
  
  /**
   * Character count display with color coding
   */
  const characterCount = useMemo(() => {
    const count = content.length;
    const percentage = (count / maxLength) * 100;
    
    let className = 'jp-comment-input-char-count';
    if (percentage >= 100) {
      className += ' jp-comment-input-char-count-error';
    } else if (percentage >= 90) {
      className += ' jp-comment-input-char-count-warning';
    }
    
    return (
      <span className={className}>
        {count}/{maxLength}
      </span>
    );
  }, [content.length, maxLength]);
  
  return (
    <div 
      ref={containerRef}
      className={`jp-comment-input ${compact ? 'jp-comment-input-compact' : ''} ${className}`}
    >
      {/* Input Header */}
      <div className="jp-comment-input-header">
        <div className="jp-comment-input-actions">
          <Button
            size="small"
            onClick={togglePreview}
            disabled={!content.trim()}
            title={showPreview ? trans.__('Edit') : trans.__('Preview')}
          >
            {showPreview ? trans.__('Edit') : trans.__('Preview')}
          </Button>
        </div>
        {characterCount}
      </div>
      
      {/* Main Input Area */}
      <div className="jp-comment-input-main">
        {!showPreview ? (
          <div className="jp-comment-input-editor">
            <textarea
              ref={textAreaRef}
              value={content}
              onChange={handleContentChange}
              onFocus={handleFocus}
              onBlur={handleBlur}
              onKeyDown={handleMentionKeyDown}
              placeholder={placeholder || trans.__('Write a comment... (use @username to mention someone)')}
              className={`jp-comment-input-textarea ${validationResult.isValid ? '' : 'jp-comment-input-textarea-error'}`}
              rows={compact ? 3 : 5}
              disabled={isSubmitting}
              maxLength={maxLength}
            />
            
            {/* @mention suggestions dropdown */}
            {showMentionSuggestions && (
              <div 
                ref={suggestionsRef}
                className="jp-comment-input-mentions"
              >
                {mentionSuggestions.map((suggestion, index) => (
                  <div
                    key={suggestion.user.id}
                    className={`jp-comment-input-mention-item ${
                      index === selectedSuggestionIndex ? 'jp-comment-input-mention-item-selected' : ''
                    }`}
                    onClick={() => selectMentionSuggestion(suggestion)}
                  >
                    <div className="jp-comment-input-mention-avatar">
                      {suggestion.user.avatar ? (
                        <img src={suggestion.user.avatar} alt={suggestion.user.displayName} />
                      ) : (
                        <div 
                          className="jp-comment-input-mention-avatar-placeholder"
                          style={{ backgroundColor: suggestion.user.color }}
                        >
                          {suggestion.user.displayName.charAt(0).toUpperCase()}
                        </div>
                      )}
                    </div>
                    <div className="jp-comment-input-mention-info">
                      <div className="jp-comment-input-mention-name">
                        {suggestion.user.displayName}
                      </div>
                      <div className="jp-comment-input-mention-username">
                        @{suggestion.user.username}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          renderPreview
        )}
      </div>
      
      {/* Validation Messages */}
      {(validationResult.errors.length > 0 || validationResult.warnings.length > 0) && (
        <div className="jp-comment-input-validation">
          {validationResult.errors.map((error, index) => (
            <div key={`error-${index}`} className="jp-comment-input-error">
              {error}
            </div>
          ))}
          {validationResult.warnings.map((warning, index) => (
            <div key={`warning-${index}`} className="jp-comment-input-warning">
              {warning}
            </div>
          ))}
        </div>
      )}
      
      {/* Action Buttons */}
      <div className="jp-comment-input-footer">
        <div className="jp-comment-input-help">
          <span className="jp-comment-input-shortcut-hint">
            {trans.__('Ctrl+Enter to submit, Escape to cancel')}
          </span>
        </div>
        <div className="jp-comment-input-buttons">
          <Button
            size="small"
            onClick={handleCancel}
            disabled={isSubmitting}
          >
            {trans.__('Cancel')}
          </Button>
          <Button
            size="small"
            className="jp-mod-accept"
            onClick={handleSubmit}
            disabled={!validationResult.isValid || isSubmitting || !content.trim()}
          >
            {isSubmitting 
              ? trans.__('Submitting...') 
              : existingComment 
                ? trans.__('Update Comment') 
                : trans.__('Add Comment')
            }
          </Button>
        </div>
      </div>
    </div>
  );
};

export default CommentInput;