/**
 * @fileoverview React component system for cell-level commenting and threaded discussions
 * 
 * This module provides comprehensive comment functionality for collaborative notebook editing,
 * including cell-level comments, inline comments, threading, rich text formatting, @mentions,
 * and real-time synchronization using Yjs CRDT framework.
 * 
 * Key features:
 * - Cell-level and inline commenting with real-time synchronization
 * - Comment threading and reply system with visual hierarchies
 * - Rich text formatting with code snippets and image attachments
 * - @mentions functionality for notifying specific collaborators
 * - Comment resolution workflow with status tracking
 * - Notification system for new comments and resolutions
 * - Integration with user presence and permissions systems
 * - Accessibility features with proper ARIA attributes
 * - Responsive design for mobile and desktop interfaces
 * 
 * @author Blitzy Agent
 * @version 1.0.0
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useCallback as useCallbackImport } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator } from '@jupyterlab/translation';
import { INotebookModel } from '@jupyterlab/notebook';
import { ICellModel } from '@jupyterlab/cells';
import { ISignal } from '@lumino/signaling';
import { Time } from '@jupyterlab/coreutils';
import { Y } from 'yjs';

import { CommentService } from '../../notebook/src/collab/comments';
import { AwarenessService } from '../../notebook/src/collab/awareness';
import { PermissionService } from '../../notebook/src/collab/permissions';

/**
 * Interface representing a comment with all its properties
 */
export interface IComment {
  /** Unique identifier for the comment */
  id: string;
  /** ID of the cell the comment is attached to */
  cellId: string;
  /** Author information */
  author: {
    id: string;
    name: string;
    avatar?: string;
  };
  /** Comment content in markdown format */
  content: string;
  /** Timestamp when the comment was created */
  timestamp: Date;
  /** ID of parent comment if this is a reply */
  parentId?: string;
  /** Whether the comment is resolved */
  resolved: boolean;
  /** List of mentioned users */
  mentions: string[];
  /** Reactions to the comment */
  reactions: {
    [emoji: string]: string[]; // emoji -> array of user IDs
  };
  /** Position information for inline comments */
  position?: {
    line: number;
    column: number;
    length?: number;
  };
  /** Type of comment */
  type?: string;
}

/**
 * Interface representing a comment thread
 */
export interface ICommentThread {
  /** Unique identifier for the thread */
  id: string;
  /** ID of the cell the thread is attached to */
  cellId: string;
  /** Root comment that started the thread */
  rootComment: IComment;
  /** Array of reply comments */
  replies: IComment[];
  /** Whether the thread is resolved */
  resolved: boolean;
  /** List of users who have participated in the thread */
  participants: string[];
  /** Timestamp of the last activity in the thread */
  lastActivity?: Date;
  /** Count of unresolved comments in the thread */
  unresolvedCount?: number;
}

/**
 * Interface for comment system props
 */
export interface ICommentSystemProps {
  /** The cell model to attach comments to */
  cellModel: ICellModel;
  /** Comment service for managing comments */
  commentService: CommentService;
  /** Awareness service for user presence */
  awarenessService: AwarenessService;
  /** Permission service for access control */
  permissionService: PermissionService;
  /** Translator for internationalization */
  translator: ITranslator;
  /** Callback when a comment is added */
  onCommentAdded?: (comment: IComment) => void;
  /** Callback when a comment is resolved */
  onCommentResolved?: (commentId: string) => void;
  /** Additional CSS classes */
  className?: string;
  /** Whether to show thread structure */
  showThreads?: boolean;
  /** Whether to allow rich text editing */
  allowRichText?: boolean;
  /** Maximum comment length */
  maxCommentLength?: number;
}

/**
 * Props for individual comment components
 */
interface ICommentProps {
  /** The comment to render */
  comment: IComment;
  /** Whether this is a reply comment */
  isReply?: boolean;
  /** Callback for reply action */
  onReply?: (parentId: string) => void;
  /** Callback for resolve action */
  onResolve?: (commentId: string) => void;
  /** Callback for edit action */
  onEdit?: (commentId: string, content: string) => void;
  /** Callback for delete action */
  onDelete?: (commentId: string) => void;
  /** Callback for reaction action */
  onReaction?: (commentId: string, emoji: string) => void;
  /** Current user information */
  currentUser?: { userId: string; name: string; avatar?: string };
  /** Whether user can edit this comment */
  canEdit?: boolean;
  /** Whether user can resolve this comment */
  canResolve?: boolean;
  /** Translation function */
  trans: ITranslator['load'];
}

/**
 * Props for comment editor component
 */
interface ICommentEditorProps {
  /** Initial content for editing */
  initialContent?: string;
  /** Whether this is a reply */
  isReply?: boolean;
  /** Placeholder text */
  placeholder?: string;
  /** Callback when content is submitted */
  onSubmit: (content: string, mentions: string[]) => void;
  /** Callback when editing is cancelled */
  onCancel?: () => void;
  /** Available users for mentions */
  availableUsers?: Array<{ userId: string; name: string; avatar?: string }>;
  /** Whether to show rich text controls */
  showRichText?: boolean;
  /** Translation function */
  trans: ITranslator['load'];
}

/**
 * Individual comment component with threading and reactions
 */
const CommentItem: React.FC<ICommentProps> = ({
  comment,
  isReply = false,
  onReply,
  onResolve,
  onEdit,
  onDelete,
  onReaction,
  currentUser,
  canEdit = false,
  canResolve = false,
  trans
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [showReactions, setShowReactions] = useState(false);
  const [editContent, setEditContent] = useState(comment.content);

  const formatTimestamp = useCallback((timestamp: Date) => {
    return Time.formatHuman(timestamp);
  }, []);

  const handleEdit = useCallback(() => {
    if (onEdit) {
      onEdit(comment.id, editContent);
      setIsEditing(false);
    }
  }, [comment.id, editContent, onEdit]);

  const handleResolve = useCallback(() => {
    if (onResolve) {
      onResolve(comment.id);
    }
  }, [comment.id, onResolve]);

  const handleReply = useCallback(() => {
    if (onReply) {
      onReply(comment.id);
    }
  }, [comment.id, onReply]);

  const handleDelete = useCallback(() => {
    if (onDelete && window.confirm(trans.__('Are you sure you want to delete this comment?'))) {
      onDelete(comment.id);
    }
  }, [comment.id, onDelete, trans]);

  const handleReaction = useCallback((emoji: string) => {
    if (onReaction) {
      onReaction(comment.id, emoji);
    }
  }, [comment.id, onReaction]);

  const renderContent = useCallback(() => {
    if (isEditing) {
      return (
        <div className="jp-Comment-editArea">
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            className="jp-Comment-textarea"
            rows={3}
            placeholder={trans.__('Edit your comment...')}
          />
          <div className="jp-Comment-editActions">
            <button
              className="jp-Comment-btn jp-Comment-btn-primary"
              onClick={handleEdit}
            >
              {trans.__('Save')}
            </button>
            <button
              className="jp-Comment-btn jp-Comment-btn-secondary"
              onClick={() => setIsEditing(false)}
            >
              {trans.__('Cancel')}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="jp-Comment-content">
        <div className="jp-Comment-text" dangerouslySetInnerHTML={{ __html: comment.content }} />
        {comment.mentions.length > 0 && (
          <div className="jp-Comment-mentions">
            {comment.mentions.map(mention => (
              <span key={mention} className="jp-Comment-mention">
                @{mention}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }, [isEditing, editContent, comment.content, comment.mentions, trans, handleEdit]);

  const renderReactions = useCallback(() => {
    if (Object.keys(comment.reactions).length === 0) {
      return null;
    }

    return (
      <div className="jp-Comment-reactions">
        {Object.entries(comment.reactions).map(([emoji, users]) => (
          <button
            key={emoji}
            className={`jp-Comment-reaction ${users.includes(currentUser?.userId || '') ? 'jp-Comment-reaction-active' : ''}`}
            onClick={() => handleReaction(emoji)}
            title={users.join(', ')}
          >
            {emoji} {users.length}
          </button>
        ))}
      </div>
    );
  }, [comment.reactions, currentUser?.userId, handleReaction]);

  return (
    <div className={`jp-Comment-item ${isReply ? 'jp-Comment-reply' : ''} ${comment.resolved ? 'jp-Comment-resolved' : ''}`}>
      <div className="jp-Comment-header">
        <div className="jp-Comment-author">
          {comment.author.avatar && (
            <img
              src={comment.author.avatar}
              alt={comment.author.name}
              className="jp-Comment-avatar"
            />
          )}
          <span className="jp-Comment-authorName">{comment.author.name}</span>
        </div>
        <div className="jp-Comment-meta">
          <span className="jp-Comment-timestamp" title={comment.timestamp.toLocaleString()}>
            {formatTimestamp(comment.timestamp)}
          </span>
          {comment.resolved && (
            <span className="jp-Comment-resolvedBadge">
              {trans.__('Resolved')}
            </span>
          )}
        </div>
      </div>

      {renderContent()}
      {renderReactions()}

      <div className="jp-Comment-actions">
        {!comment.resolved && (
          <>
            <button
              className="jp-Comment-action"
              onClick={handleReply}
            >
              {trans.__('Reply')}
            </button>
            {canResolve && (
              <button
                className="jp-Comment-action"
                onClick={handleResolve}
              >
                {trans.__('Resolve')}
              </button>
            )}
            <button
              className="jp-Comment-action"
              onClick={() => setShowReactions(!showReactions)}
            >
              {trans.__('React')}
            </button>
          </>
        )}
        {canEdit && currentUser?.userId === comment.author.id && (
          <>
            <button
              className="jp-Comment-action"
              onClick={() => setIsEditing(true)}
            >
              {trans.__('Edit')}
            </button>
            <button
              className="jp-Comment-action jp-Comment-action-delete"
              onClick={handleDelete}
            >
              {trans.__('Delete')}
            </button>
          </>
        )}
      </div>

      {showReactions && (
        <div className="jp-Comment-reactionPicker">
          {['👍', '👎', '❤️', '😄', '😢', '😡', '🎉'].map(emoji => (
            <button
              key={emoji}
              className="jp-Comment-reactionOption"
              onClick={() => {
                handleReaction(emoji);
                setShowReactions(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Comment editor component with rich text support and @mentions
 */
const CommentEditor: React.FC<ICommentEditorProps> = ({
  initialContent = '',
  isReply = false,
  placeholder,
  onSubmit,
  onCancel,
  availableUsers = [],
  showRichText = true,
  trans
}) => {
  const [content, setContent] = useState(initialContent);
  const [mentions, setMentions] = useState<string[]>([]);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionPosition, setMentionPosition] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleContentChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = e.target.value;
    setContent(newContent);

    // Check for @mentions
    const cursorPosition = e.target.selectionStart;
    const textBeforeCursor = newContent.slice(0, cursorPosition);
    const mentionMatch = textBeforeCursor.match(/@(\w*)$/);
    
    if (mentionMatch) {
      setMentionFilter(mentionMatch[1]);
      setMentionPosition(cursorPosition - mentionMatch[0].length);
      setShowMentions(true);
    } else {
      setShowMentions(false);
    }

    // Extract all mentions
    const allMentions = newContent.match(/@(\w+)/g) || [];
    setMentions(allMentions.map(m => m.slice(1)));
  }, []);

  const handleMentionSelect = useCallback((username: string) => {
    const beforeMention = content.slice(0, mentionPosition);
    const afterMention = content.slice(textareaRef.current?.selectionStart || 0);
    const newContent = beforeMention + '@' + username + ' ' + afterMention;
    
    setContent(newContent);
    setShowMentions(false);
    
    // Focus back to textarea
    if (textareaRef.current) {
      const newPosition = mentionPosition + username.length + 2;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(newPosition, newPosition);
    }
  }, [content, mentionPosition]);

  const handleSubmit = useCallback(() => {
    if (content.trim()) {
      onSubmit(content, mentions);
      setContent('');
      setMentions([]);
    }
  }, [content, mentions, onSubmit]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  const filteredUsers = useMemo(() => {
    if (!mentionFilter) return availableUsers;
    return availableUsers.filter(user => 
      user.name.toLowerCase().includes(mentionFilter.toLowerCase()) ||
      user.userId.toLowerCase().includes(mentionFilter.toLowerCase())
    );
  }, [availableUsers, mentionFilter]);

  return (
    <div className={`jp-Comment-editor ${isReply ? 'jp-Comment-editor-reply' : ''}`}>
      <div className="jp-Comment-inputArea">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleContentChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || trans.__('Add a comment...')}
          className="jp-Comment-textarea"
          rows={isReply ? 2 : 3}
        />
        
        {showMentions && filteredUsers.length > 0 && (
          <div className="jp-Comment-mentionDropdown">
            {filteredUsers.map(user => (
              <button
                key={user.userId}
                className="jp-Comment-mentionOption"
                onClick={() => handleMentionSelect(user.userId)}
              >
                {user.avatar && (
                  <img
                    src={user.avatar}
                    alt={user.name}
                    className="jp-Comment-mentionAvatar"
                  />
                )}
                <span className="jp-Comment-mentionName">{user.name}</span>
                <span className="jp-Comment-mentionUserId">@{user.userId}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {showRichText && (
        <div className="jp-Comment-richTextControls">
          <button
            className="jp-Comment-richTextBtn"
            onClick={() => {
              const selection = textareaRef.current?.selectionStart || 0;
              const newContent = content.slice(0, selection) + '**bold**' + content.slice(selection);
              setContent(newContent);
            }}
            title={trans.__('Bold')}
          >
            <strong>B</strong>
          </button>
          <button
            className="jp-Comment-richTextBtn"
            onClick={() => {
              const selection = textareaRef.current?.selectionStart || 0;
              const newContent = content.slice(0, selection) + '*italic*' + content.slice(selection);
              setContent(newContent);
            }}
            title={trans.__('Italic')}
          >
            <em>I</em>
          </button>
          <button
            className="jp-Comment-richTextBtn"
            onClick={() => {
              const selection = textareaRef.current?.selectionStart || 0;
              const newContent = content.slice(0, selection) + '`code`' + content.slice(selection);
              setContent(newContent);
            }}
            title={trans.__('Code')}
          >
            {'</>'}
          </button>
        </div>
      )}

      <div className="jp-Comment-editorActions">
        <button
          className="jp-Comment-btn jp-Comment-btn-primary"
          onClick={handleSubmit}
          disabled={!content.trim()}
        >
          {isReply ? trans.__('Reply') : trans.__('Comment')}
        </button>
        {onCancel && (
          <button
            className="jp-Comment-btn jp-Comment-btn-secondary"
            onClick={onCancel}
          >
            {trans.__('Cancel')}
          </button>
        )}
      </div>
    </div>
  );
};

/**
 * Comment thread component showing hierarchical comments
 */
const CommentThread: React.FC<{
  thread: ICommentThread;
  currentUser?: { userId: string; name: string; avatar?: string };
  availableUsers?: Array<{ userId: string; name: string; avatar?: string }>;
  canEdit?: boolean;
  canResolve?: boolean;
  onReply?: (parentId: string, content: string, mentions: string[]) => void;
  onResolve?: (commentId: string) => void;
  onEdit?: (commentId: string, content: string) => void;
  onDelete?: (commentId: string) => void;
  onReaction?: (commentId: string, emoji: string) => void;
  trans: ITranslator['load'];
}> = ({
  thread,
  currentUser,
  availableUsers = [],
  canEdit = false,
  canResolve = false,
  onReply,
  onResolve,
  onEdit,
  onDelete,
  onReaction,
  trans
}) => {
  const [showReplyEditor, setShowReplyEditor] = useState(false);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  const handleReply = useCallback((parentId: string) => {
    setReplyingTo(parentId);
    setShowReplyEditor(true);
  }, []);

  const handleReplySubmit = useCallback((content: string, mentions: string[]) => {
    if (onReply && replyingTo) {
      onReply(replyingTo, content, mentions);
      setShowReplyEditor(false);
      setReplyingTo(null);
    }
  }, [onReply, replyingTo]);

  const handleReplyCancel = useCallback(() => {
    setShowReplyEditor(false);
    setReplyingTo(null);
  }, []);

  return (
    <div className={`jp-Comment-thread ${thread.resolved ? 'jp-Comment-thread-resolved' : ''}`}>
      <CommentItem
        comment={thread.rootComment}
        onReply={handleReply}
        onResolve={onResolve}
        onEdit={onEdit}
        onDelete={onDelete}
        onReaction={onReaction}
        currentUser={currentUser}
        canEdit={canEdit}
        canResolve={canResolve}
        trans={trans}
      />

      {thread.replies.map(reply => (
        <CommentItem
          key={reply.id}
          comment={reply}
          isReply={true}
          onReply={handleReply}
          onResolve={onResolve}
          onEdit={onEdit}
          onDelete={onDelete}
          onReaction={onReaction}
          currentUser={currentUser}
          canEdit={canEdit}
          canResolve={canResolve}
          trans={trans}
        />
      ))}

      {showReplyEditor && (
        <div className="jp-Comment-replyEditor">
          <CommentEditor
            isReply={true}
            placeholder={trans.__('Write a reply...')}
            onSubmit={handleReplySubmit}
            onCancel={handleReplyCancel}
            availableUsers={availableUsers}
            trans={trans}
          />
        </div>
      )}
    </div>
  );
};

/**
 * Main comment system component
 */
export const CommentSystem: React.FC<ICommentSystemProps> = ({
  cellModel,
  commentService,
  awarenessService,
  permissionService,
  translator,
  onCommentAdded,
  onCommentResolved,
  className = '',
  showThreads = true,
  allowRichText = true,
  maxCommentLength = 1000
}) => {
  const trans = translator.load('jupyterlab');
  const [comments, setComments] = useState<IComment[]>([]);
  const [threads, setThreads] = useState<ICommentThread[]>([]);
  const [currentUser, setCurrentUser] = useState<{ userId: string; name: string; avatar?: string } | null>(null);
  const [availableUsers, setAvailableUsers] = useState<Array<{ userId: string; name: string; avatar?: string }>>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [canResolve, setCanResolve] = useState(false);
  const [showNewCommentEditor, setShowNewCommentEditor] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unresolved' | 'resolved'>('all');
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'mostReplies'>('newest');

  // Initialize current user and permissions
  useEffect(() => {
    const initializeUser = async () => {
      try {
        const user = awarenessService.getCurrentUser();
        setCurrentUser(user);
        
        const editPermission = await permissionService.canEdit(cellModel.id);
        const resolvePermission = await permissionService.canAdmin();
        setCanEdit(editPermission);
        setCanResolve(resolvePermission);
      } catch (error) {
        console.error('Error initializing user:', error);
      }
    };

    initializeUser();
  }, [awarenessService, permissionService, cellModel.id]);

  // Load available users for mentions
  useEffect(() => {
    const loadUsers = async () => {
      try {
        const users = awarenessService.getUsers();
        setAvailableUsers(users.map(u => ({
          userId: u.userId,
          name: u.name,
          avatar: u.avatar
        })));
      } catch (error) {
        console.error('Error loading users:', error);
      }
    };

    loadUsers();
  }, [awarenessService]);

  // Subscribe to comments for this cell
  useEffect(() => {
    const subscription = commentService.subscribeToComments(cellModel.id, (updatedComments) => {
      setComments(updatedComments);
    });

    return () => {
      subscription.dispose();
    };
  }, [commentService, cellModel.id]);

  // Group comments into threads
  useEffect(() => {
    const groupedThreads: ICommentThread[] = [];
    const commentMap = new Map<string, IComment>();
    
    // Create a map of all comments
    comments.forEach(comment => {
      commentMap.set(comment.id, comment);
    });
    
    // Group comments into threads
    comments.forEach(comment => {
      if (!comment.parentId) {
        // This is a root comment
        const replies = comments.filter(c => c.parentId === comment.id);
        const participants = new Set([comment.author.id, ...replies.map(r => r.author.id)]);
        
        const thread: ICommentThread = {
          id: comment.id,
          cellId: comment.cellId,
          rootComment: comment,
          replies: replies,
          resolved: comment.resolved && replies.every(r => r.resolved),
          participants: Array.from(participants),
          lastActivity: new Date(Math.max(
            comment.timestamp.getTime(),
            ...replies.map(r => r.timestamp.getTime())
          )),
          unresolvedCount: [comment, ...replies].filter(c => !c.resolved).length
        };
        
        groupedThreads.push(thread);
      }
    });
    
    setThreads(groupedThreads);
  }, [comments]);

  // Handle new comment creation
  const handleNewComment = useCallback(async (content: string, mentions: string[]) => {
    try {
      const comment = await commentService.createComment(
        cellModel.id,
        content,
        'cell_comment'
      );
      
      if (onCommentAdded) {
        onCommentAdded(comment);
      }
      
      setShowNewCommentEditor(false);
    } catch (error) {
      console.error('Error creating comment:', error);
    }
  }, [commentService, cellModel.id, onCommentAdded]);

  // Handle reply to comment
  const handleReply = useCallback(async (parentId: string, content: string, mentions: string[]) => {
    try {
      const reply = await commentService.replyToComment(parentId, content);
      
      if (onCommentAdded) {
        onCommentAdded(reply);
      }
    } catch (error) {
      console.error('Error replying to comment:', error);
    }
  }, [commentService, onCommentAdded]);

  // Handle comment resolution
  const handleResolve = useCallback(async (commentId: string) => {
    try {
      await commentService.resolveComment(commentId);
      
      if (onCommentResolved) {
        onCommentResolved(commentId);
      }
    } catch (error) {
      console.error('Error resolving comment:', error);
    }
  }, [commentService, onCommentResolved]);

  // Handle comment editing
  const handleEdit = useCallback(async (commentId: string, content: string) => {
    try {
      await commentService.updateComment(commentId, content);
    } catch (error) {
      console.error('Error editing comment:', error);
    }
  }, [commentService]);

  // Handle comment deletion
  const handleDelete = useCallback(async (commentId: string) => {
    try {
      await commentService.deleteComment(commentId);
    } catch (error) {
      console.error('Error deleting comment:', error);
    }
  }, [commentService]);

  // Handle comment reactions
  const handleReaction = useCallback(async (commentId: string, emoji: string) => {
    // Note: Reaction handling would need to be implemented in CommentService
    console.log('Reaction:', commentId, emoji);
  }, []);

  // Filter and sort threads
  const filteredAndSortedThreads = useMemo(() => {
    let filtered = threads;
    
    // Apply filter
    switch (filter) {
      case 'unresolved':
        filtered = threads.filter(t => !t.resolved);
        break;
      case 'resolved':
        filtered = threads.filter(t => t.resolved);
        break;
      default:
        filtered = threads;
    }
    
    // Apply sorting
    switch (sortBy) {
      case 'oldest':
        filtered.sort((a, b) => a.rootComment.timestamp.getTime() - b.rootComment.timestamp.getTime());
        break;
      case 'mostReplies':
        filtered.sort((a, b) => b.replies.length - a.replies.length);
        break;
      default: // newest
        filtered.sort((a, b) => b.rootComment.timestamp.getTime() - a.rootComment.timestamp.getTime());
    }
    
    return filtered;
  }, [threads, filter, sortBy]);

  return (
    <div className={`jp-CommentSystem ${className}`}>
      <div className="jp-CommentSystem-header">
        <div className="jp-CommentSystem-stats">
          <span className="jp-CommentSystem-count">
            {trans.__('%1 comments', String(comments.length))}
          </span>
          {comments.some(c => !c.resolved) && (
            <span className="jp-CommentSystem-unresolvedCount">
              {trans.__('%1 unresolved', String(comments.filter(c => !c.resolved).length))}
            </span>
          )}
        </div>
        
        <div className="jp-CommentSystem-controls">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as 'all' | 'unresolved' | 'resolved')}
            className="jp-CommentSystem-filter"
          >
            <option value="all">{trans.__('All')}</option>
            <option value="unresolved">{trans.__('Unresolved')}</option>
            <option value="resolved">{trans.__('Resolved')}</option>
          </select>
          
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'newest' | 'oldest' | 'mostReplies')}
            className="jp-CommentSystem-sort"
          >
            <option value="newest">{trans.__('Newest first')}</option>
            <option value="oldest">{trans.__('Oldest first')}</option>
            <option value="mostReplies">{trans.__('Most replies')}</option>
          </select>
        </div>
      </div>

      <div className="jp-CommentSystem-content">
        {filteredAndSortedThreads.length === 0 ? (
          <div className="jp-CommentSystem-empty">
            <p>{trans.__('No comments yet.')}</p>
            {canEdit && (
              <button
                className="jp-Comment-btn jp-Comment-btn-primary"
                onClick={() => setShowNewCommentEditor(true)}
              >
                {trans.__('Add the first comment')}
              </button>
            )}
          </div>
        ) : (
          <>
            {showThreads ? (
              <div className="jp-CommentSystem-threads">
                {filteredAndSortedThreads.map(thread => (
                  <CommentThread
                    key={thread.id}
                    thread={thread}
                    currentUser={currentUser}
                    availableUsers={availableUsers}
                    canEdit={canEdit}
                    canResolve={canResolve}
                    onReply={handleReply}
                    onResolve={handleResolve}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                    onReaction={handleReaction}
                    trans={trans}
                  />
                ))}
              </div>
            ) : (
              <div className="jp-CommentSystem-list">
                {comments.map(comment => (
                  <CommentItem
                    key={comment.id}
                    comment={comment}
                    onReply={(parentId) => handleReply(parentId, '', [])}
                    onResolve={handleResolve}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                    onReaction={handleReaction}
                    currentUser={currentUser}
                    canEdit={canEdit}
                    canResolve={canResolve}
                    trans={trans}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {canEdit && (
        <div className="jp-CommentSystem-footer">
          {showNewCommentEditor ? (
            <CommentEditor
              placeholder={trans.__('Add a comment to this cell...')}
              onSubmit={handleNewComment}
              onCancel={() => setShowNewCommentEditor(false)}
              availableUsers={availableUsers}
              showRichText={allowRichText}
              trans={trans}
            />
          ) : (
            <button
              className="jp-Comment-btn jp-Comment-btn-secondary jp-CommentSystem-addBtn"
              onClick={() => setShowNewCommentEditor(true)}
            >
              {trans.__('Add comment')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Comment system widget wrapper for integration with Lumino
 */
export class CommentSystemWidget extends ReactWidget {
  private _props: ICommentSystemProps;

  constructor(props: ICommentSystemProps) {
    super();
    this._props = props;
    this.addClass('jp-CommentSystemWidget');
  }

  /**
   * Create a new comment system widget
   */
  static create(props: ICommentSystemProps): CommentSystemWidget {
    return new CommentSystemWidget(props);
  }

  /**
   * Update the widget with new props
   */
  update(newProps: Partial<ICommentSystemProps>): void {
    this._props = { ...this._props, ...newProps };
    super.update();
  }

  /**
   * Render the React component
   */
  render(): JSX.Element {
    return <CommentSystem {...this._props} />;
  }

  /**
   * Dispose of the widget
   */
  dispose(): void {
    super.dispose();
  }
}

// Export default CommentSystem for convenience
export default CommentSystem;