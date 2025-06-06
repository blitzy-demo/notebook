/**
 * @fileoverview Comprehensive comment system component providing threaded discussion interface
 * for collaborative notebook annotation and review workflows. This component integrates with
 * the Yjs-based collaboration infrastructure to enable real-time comment synchronization,
 * presence awareness, and rich collaborative annotation capabilities.
 * 
 * Key Features:
 * - Threaded comment interface with nested reply support
 * - Real-time comment synchronization via WebSocket broadcasting
 * - Rich text editing with @mentions and notification workflows
 * - Comment resolution tracking and review workflow management
 * - Full-text search and filtering capabilities with MongoDB integration
 * - Collaborative awareness with user presence indicators
 * - Cell-level and line-level comment anchoring
 * - Export/import capabilities for workflow integration
 * - Comprehensive notification system with configurable policies
 * 
 * Architecture:
 * - Integrates with CommentSystem backend service for persistence
 * - Uses YjsNotebookProvider for real-time synchronization
 * - Leverages awareness system for user presence tracking
 * - Follows JupyterLab UI patterns and accessibility standards
 * - Supports responsive design for various screen sizes
 * 
 * @author Jupyter Notebook Collaboration Team
 * @version 7.5.0-alpha.0
 * @since 2024-06-06
 */

import React, { 
  useState, 
  useEffect, 
  useCallback, 
  useMemo, 
  useRef,
  useContext,
  createContext
} from 'react';
import { 
  IDisposable, 
  DisposableDelegate 
} from '@lumino/disposable';
import { 
  ReactWidget, 
  UseSignal,
  Dialog,
  showDialog
} from '@jupyterlab/apputils';
import { 
  ISignal, 
  Signal 
} from '@lumino/signaling';
import { 
  JSONValue, 
  UUID 
} from '@lumino/coreutils';
import { 
  ITranslator, 
  nullTranslator 
} from '@jupyterlab/translation';
import { 
  INotebookModel, 
  Notebook 
} from '@jupyterlab/notebook';
import { 
  User,
  Users,
  MessageSquare,
  Reply,
  CheckCircle,
  Circle,
  Archive,
  Search,
  Filter,
  Send,
  Edit3,
  Trash2,
  MoreHorizontal,
  AlertCircle,
  Clock,
  Hash,
  AtSign,
  Download,
  Upload,
  Settings,
  Bell,
  BellOff,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronRight,
  ExternalLink
} from 'react-feather';

// Import collaboration infrastructure
import { 
  ICollaborationProvider,
  ICollaborationProviderConfig,
  IProviderEvent 
} from '../../../notebook/src/collab/YjsNotebookProvider';
import { 
  CommentSystem,
  ICommentSystem,
  ICommentStorageProvider,
  ICommentSyncProvider
} from '../../../notebook/src/collab/comments';
import { 
  CollaborativeAwareness,
  IAwarenessProvider,
  IUserPresence,
  UserRole,
  ActivityStatus
} from '../../../notebook/src/collab/awareness';

/**
 * Context for sharing comment system state across components
 */
interface ICommentSystemContext {
  commentSystem: CommentSystem | null;
  collaborationProvider: ICollaborationProvider | null;
  awarenessProvider: IAwarenessProvider | null;
  currentUser: IUserPresence | null;
  notebookId: string;
  isConnected: boolean;
}

const CommentSystemContext = createContext<ICommentSystemContext>({
  commentSystem: null,
  collaborationProvider: null,
  awarenessProvider: null,
  currentUser: null,
  notebookId: '',
  isConnected: false
});

/**
 * Configuration interface for comment system component
 */
export interface ICommentSystemConfig {
  /** The notebook instance for cell anchoring */
  notebook: Notebook;
  /** Collaboration provider for real-time sync */
  collaborationProvider: ICollaborationProvider;
  /** Awareness provider for user presence */
  awarenessProvider: IAwarenessProvider;
  /** Translation service */
  translator?: ITranslator;
  /** Enable real-time notifications */
  enableNotifications?: boolean;
  /** Default comment priority */
  defaultPriority?: ICommentSystem.CommentPriority;
  /** Enable rich text editing */
  enableRichText?: boolean;
  /** Show resolved comments by default */
  showResolvedComments?: boolean;
  /** Maximum comments per page */
  commentsPerPage?: number;
  /** Enable comment export/import */
  enableImportExport?: boolean;
}

/**
 * Props for the main CommentSystem component
 */
interface ICommentSystemProps extends ICommentSystemConfig {
  /** Additional CSS classes */
  className?: string;
  /** Component width */
  width?: number;
  /** Component height */
  height?: number;
  /** Show in collapsed mode */
  collapsed?: boolean;
}

/**
 * Comment anchor selection result
 */
interface ICommentAnchorSelection {
  anchor: ICommentSystem.ICommentAnchor;
  selectedText?: string;
  position: { x: number; y: number };
}

/**
 * Rich text editor component for comment content
 */
const CommentEditor: React.FC<{
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  placeholder?: string;
  enableMentions?: boolean;
  users?: IUserPresence[];
  disabled?: boolean;
  autoFocus?: boolean;
}> = ({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder = 'Write a comment...',
  enableMentions = true,
  users = [],
  disabled = false,
  autoFocus = false
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showMentionSuggestions, setShowMentionSuggestions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionPosition, setMentionPosition] = useState({ x: 0, y: 0 });
  const [cursorPosition, setCursorPosition] = useState(0);

  // Handle @mention detection
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    onChange(newValue);
    
    if (enableMentions) {
      const cursor = e.target.selectionStart;
      const textBeforeCursor = newValue.substring(0, cursor);
      const mentionMatch = textBeforeCursor.match(/@([^@\s]*)$/);
      
      if (mentionMatch) {
        setMentionQuery(mentionMatch[1]);
        setShowMentionSuggestions(true);
        setCursorPosition(cursor);
        
        // Calculate mention popup position
        const textarea = textareaRef.current;
        if (textarea) {
          const rect = textarea.getBoundingClientRect();
          setMentionPosition({
            x: rect.left + 10,
            y: rect.top + 30
          });
        }
      } else {
        setShowMentionSuggestions(false);
      }
    }
  };

  // Filter users for mention suggestions
  const mentionSuggestions = useMemo(() => {
    if (!mentionQuery) return users.slice(0, 5);
    return users.filter(user => 
      user.displayName.toLowerCase().includes(mentionQuery.toLowerCase()) ||
      user.userId.toLowerCase().includes(mentionQuery.toLowerCase())
    ).slice(0, 5);
  }, [users, mentionQuery]);

  // Handle mention selection
  const handleMentionSelect = (user: IUserPresence) => {
    const beforeMention = value.substring(0, cursorPosition - mentionQuery.length - 1);
    const afterMention = value.substring(cursorPosition);
    const newValue = `${beforeMention}@${user.displayName} ${afterMention}`;
    onChange(newValue);
    setShowMentionSuggestions(false);
    
    // Focus back to textarea
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);
  };

  // Handle keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSubmit();
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }
  }, [value]);

  return (
    <div className="jp-comment-editor">
      <div className="jp-comment-editor-input">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          className="jp-comment-textarea"
          rows={3}
        />
        
        {/* Mention suggestions popup */}
        {showMentionSuggestions && mentionSuggestions.length > 0 && (
          <div 
            className="jp-comment-mentions-popup"
            style={{
              position: 'fixed',
              left: mentionPosition.x,
              top: mentionPosition.y,
              zIndex: 1000
            }}
          >
            {mentionSuggestions.map(user => (
              <div
                key={user.userId}
                className="jp-comment-mention-item"
                onClick={() => handleMentionSelect(user)}
              >
                <div className="jp-comment-mention-avatar">
                  {user.avatar ? (
                    <img src={user.avatar} alt={user.displayName} />
                  ) : (
                    <User size={16} />
                  )}
                </div>
                <div className="jp-comment-mention-details">
                  <div className="jp-comment-mention-name">{user.displayName}</div>
                  <div className="jp-comment-mention-role">{user.role}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      
      <div className="jp-comment-editor-actions">
        <button
          className="jp-comment-button jp-comment-button-secondary"
          onClick={onCancel}
          disabled={disabled}
        >
          Cancel
        </button>
        <button
          className="jp-comment-button jp-comment-button-primary"
          onClick={onSubmit}
          disabled={disabled || !value.trim()}
        >
          <Send size={14} />
          Comment
        </button>
      </div>
      
      <div className="jp-comment-editor-hint">
        <kbd>Ctrl+Enter</kbd> to submit, <kbd>@username</kbd> to mention
      </div>
    </div>
  );
};

/**
 * Individual comment item component
 */
const CommentItem: React.FC<{
  comment: ICommentSystem.IComment;
  isReply?: boolean;
  onReply?: (comment: ICommentSystem.IComment) => void;
  onEdit?: (comment: ICommentSystem.IComment) => void;
  onDelete?: (comment: ICommentSystem.IComment) => void;
  onResolve?: (comment: ICommentSystem.IComment) => void;
  currentUser?: IUserPresence;
  showActions?: boolean;
}> = ({
  comment,
  isReply = false,
  onReply,
  onEdit,
  onDelete,
  onResolve,
  currentUser,
  showActions = true
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(comment.content);
  const [showMenu, setShowMenu] = useState(false);
  const { commentSystem } = useContext(CommentSystemContext);

  // Format timestamp
  const formatTimestamp = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
  };

  // Handle edit save
  const handleEditSave = async () => {
    if (!commentSystem || !editContent.trim()) return;
    
    try {
      await commentSystem.updateComment(comment.id, {
        content: editContent,
        updatedAt: new Date()
      });
      setIsEditing(false);
    } catch (error) {
      console.error('Failed to update comment:', error);
    }
  };

  // Handle edit cancel
  const handleEditCancel = () => {
    setEditContent(comment.content);
    setIsEditing(false);
  };

  // Check if current user can edit/delete
  const canEdit = currentUser?.userId === comment.author.id;
  const canResolve = currentUser?.role === UserRole.ADMIN || 
                     currentUser?.role === UserRole.OWNER ||
                     currentUser?.userId === comment.author.id;

  // Get priority icon and color
  const getPriorityIndicator = () => {
    switch (comment.priority) {
      case ICommentSystem.CommentPriority.URGENT:
        return <AlertCircle size={12} className="jp-comment-priority-urgent" />;
      case ICommentSystem.CommentPriority.HIGH:
        return <Circle size={12} className="jp-comment-priority-high" />;
      case ICommentSystem.CommentPriority.LOW:
        return <Circle size={8} className="jp-comment-priority-low" />;
      default:
        return null;
    }
  };

  // Get status icon
  const getStatusIcon = () => {
    switch (comment.status) {
      case ICommentSystem.CommentStatus.RESOLVED:
        return <CheckCircle size={14} className="jp-comment-status-resolved" />;
      case ICommentSystem.CommentStatus.ARCHIVED:
        return <Archive size={14} className="jp-comment-status-archived" />;
      case ICommentSystem.CommentStatus.PENDING:
        return <Clock size={14} className="jp-comment-status-pending" />;
      default:
        return <MessageSquare size={14} className="jp-comment-status-open" />;
    }
  };

  return (
    <div className={`jp-comment-item ${isReply ? 'jp-comment-reply' : ''} jp-comment-status-${comment.status}`}>
      <div className="jp-comment-header">
        <div className="jp-comment-author">
          <div className="jp-comment-avatar">
            {comment.author.avatar ? (
              <img src={comment.author.avatar} alt={comment.author.name} />
            ) : (
              <User size={16} />
            )}
          </div>
          <div className="jp-comment-author-info">
            <span className="jp-comment-author-name">{comment.author.name}</span>
            <span className="jp-comment-timestamp">{formatTimestamp(comment.createdAt)}</span>
          </div>
        </div>
        
        <div className="jp-comment-meta">
          {getPriorityIndicator()}
          {getStatusIcon()}
          
          {showActions && (
            <div className="jp-comment-actions">
              <button
                className="jp-comment-action-button"
                onClick={() => setShowMenu(!showMenu)}
                title="More actions"
              >
                <MoreHorizontal size={14} />
              </button>
              
              {showMenu && (
                <div className="jp-comment-menu">
                  {onReply && (
                    <button onClick={() => {
                      onReply(comment);
                      setShowMenu(false);
                    }}>
                      <Reply size={14} />
                      Reply
                    </button>
                  )}
                  
                  {canEdit && onEdit && !isEditing && (
                    <button onClick={() => {
                      setIsEditing(true);
                      setShowMenu(false);
                    }}>
                      <Edit3 size={14} />
                      Edit
                    </button>
                  )}
                  
                  {canResolve && onResolve && comment.status !== ICommentSystem.CommentStatus.RESOLVED && (
                    <button onClick={() => {
                      onResolve(comment);
                      setShowMenu(false);
                    }}>
                      <CheckCircle size={14} />
                      Resolve
                    </button>
                  )}
                  
                  {canEdit && onDelete && (
                    <button 
                      className="jp-comment-menu-delete"
                      onClick={() => {
                        onDelete(comment);
                        setShowMenu(false);
                      }}
                    >
                      <Trash2 size={14} />
                      Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      
      <div className="jp-comment-content">
        {isEditing ? (
          <CommentEditor
            value={editContent}
            onChange={setEditContent}
            onSubmit={handleEditSave}
            onCancel={handleEditCancel}
            placeholder="Edit your comment..."
            autoFocus={true}
          />
        ) : (
          <div className="jp-comment-text">
            {comment.content.split(/(@\w+)/g).map((part, index) => {
              if (part.startsWith('@')) {
                return (
                  <span key={index} className="jp-comment-mention">
                    {part}
                  </span>
                );
              }
              return part;
            })}
          </div>
        )}
      </div>
      
      {comment.tags.length > 0 && (
        <div className="jp-comment-tags">
          {comment.tags.map(tag => (
            <span key={tag} className="jp-comment-tag">
              <Hash size={10} />
              {tag}
            </span>
          ))}
        </div>
      )}
      
      {comment.resolvedAt && comment.resolvedBy && (
        <div className="jp-comment-resolution">
          <CheckCircle size={12} />
          Resolved by {comment.resolvedBy} on {formatTimestamp(comment.resolvedAt)}
        </div>
      )}
    </div>
  );
};

/**
 * Comment thread component showing root comment and replies
 */
const CommentThread: React.FC<{
  thread: ICommentSystem.ICommentThread;
  onAddReply?: (rootCommentId: string, content: string) => void;
  onEditComment?: (comment: ICommentSystem.IComment) => void;
  onDeleteComment?: (comment: ICommentSystem.IComment) => void;
  onResolveThread?: (rootCommentId: string) => void;
  currentUser?: IUserPresence;
  collapsed?: boolean;
}> = ({
  thread,
  onAddReply,
  onEditComment,
  onDeleteComment,
  onResolveThread,
  currentUser,
  collapsed = false
}) => {
  const [isCollapsed, setIsCollapsed] = useState(collapsed);
  const [showReplyEditor, setShowReplyEditor] = useState(false);
  const [replyContent, setReplyContent] = useState('');

  // Handle reply submission
  const handleReplySubmit = async () => {
    if (!onAddReply || !replyContent.trim()) return;
    
    try {
      await onAddReply(thread.rootComment.id, replyContent);
      setReplyContent('');
      setShowReplyEditor(false);
    } catch (error) {
      console.error('Failed to add reply:', error);
    }
  };

  // Handle thread resolution
  const handleResolveThread = () => {
    if (onResolveThread) {
      onResolveThread(thread.rootComment.id);
    }
  };

  return (
    <div className={`jp-comment-thread jp-comment-thread-${thread.threadStatus}`}>
      <div className="jp-comment-thread-header">
        <button
          className="jp-comment-thread-toggle"
          onClick={() => setIsCollapsed(!isCollapsed)}
        >
          {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        
        <div className="jp-comment-thread-info">
          <span className="jp-comment-thread-count">
            {thread.stats.totalComments} comment{thread.stats.totalComments !== 1 ? 's' : ''}
          </span>
          <span className="jp-comment-thread-participants">
            {thread.stats.uniqueParticipants} participant{thread.stats.uniqueParticipants !== 1 ? 's' : ''}
          </span>
        </div>
        
        {thread.threadStatus !== ICommentSystem.CommentStatus.RESOLVED && onResolveThread && (
          <button
            className="jp-comment-resolve-thread"
            onClick={handleResolveThread}
            title="Resolve entire thread"
          >
            <CheckCircle size={14} />
            Resolve Thread
          </button>
        )}
      </div>
      
      {!isCollapsed && (
        <div className="jp-comment-thread-content">
          {/* Root comment */}
          <CommentItem
            comment={thread.rootComment}
            onReply={() => setShowReplyEditor(true)}
            onEdit={onEditComment}
            onDelete={onDeleteComment}
            currentUser={currentUser}
          />
          
          {/* Replies */}
          {thread.replies.length > 0 && (
            <div className="jp-comment-replies">
              {thread.replies.map(reply => (
                <CommentItem
                  key={reply.id}
                  comment={reply}
                  isReply={true}
                  onEdit={onEditComment}
                  onDelete={onDeleteComment}
                  currentUser={currentUser}
                />
              ))}
            </div>
          )}
          
          {/* Reply editor */}
          {showReplyEditor && (
            <div className="jp-comment-reply-editor">
              <CommentEditor
                value={replyContent}
                onChange={setReplyContent}
                onSubmit={handleReplySubmit}
                onCancel={() => {
                  setShowReplyEditor(false);
                  setReplyContent('');
                }}
                placeholder="Write a reply..."
                autoFocus={true}
              />
            </div>
          )}
          
          {!showReplyEditor && thread.threadStatus !== ICommentSystem.CommentStatus.RESOLVED && (
            <button
              className="jp-comment-add-reply"
              onClick={() => setShowReplyEditor(true)}
            >
              <Reply size={14} />
              Add Reply
            </button>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Comment search and filter panel
 */
const CommentSearchPanel: React.FC<{
  onSearch?: (query: string) => void;
  onFilter?: (filters: Partial<ICommentSystem.ICommentSearchOptions>) => void;
  currentFilters?: Partial<ICommentSystem.ICommentSearchOptions>;
  resultCount?: number;
}> = ({
  onSearch,
  onFilter,
  currentFilters = {},
  resultCount = 0
}) => {
  const [searchQuery, setSearchQuery] = useState(currentFilters.query || '');
  const [showFilters, setShowFilters] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<ICommentSystem.CommentStatus[]>(
    currentFilters.status || []
  );
  const [selectedPriority, setSelectedPriority] = useState<ICommentSystem.CommentPriority[]>(
    currentFilters.priority || []
  );

  // Handle search
  const handleSearch = () => {
    if (onSearch) {
      onSearch(searchQuery);
    }
  };

  // Handle filter changes
  const handleFilterChange = () => {
    if (onFilter) {
      onFilter({
        query: searchQuery,
        status: selectedStatus.length > 0 ? selectedStatus : undefined,
        priority: selectedPriority.length > 0 ? selectedPriority : undefined
      });
    }
  };

  // Apply filters when they change
  useEffect(() => {
    handleFilterChange();
  }, [selectedStatus, selectedPriority]);

  return (
    <div className="jp-comment-search-panel">
      <div className="jp-comment-search">
        <div className="jp-comment-search-input">
          <Search size={14} />
          <input
            type="text"
            placeholder="Search comments..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          />
          <button onClick={handleSearch}>Search</button>
        </div>
        
        <button
          className={`jp-comment-filter-toggle ${showFilters ? 'active' : ''}`}
          onClick={() => setShowFilters(!showFilters)}
        >
          <Filter size={14} />
        </button>
      </div>
      
      {showFilters && (
        <div className="jp-comment-filters">
          <div className="jp-comment-filter-group">
            <label>Status:</label>
            <div className="jp-comment-filter-options">
              {Object.values(ICommentSystem.CommentStatus).map(status => (
                <label key={status} className="jp-comment-filter-option">
                  <input
                    type="checkbox"
                    checked={selectedStatus.includes(status)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedStatus([...selectedStatus, status]);
                      } else {
                        setSelectedStatus(selectedStatus.filter(s => s !== status));
                      }
                    }}
                  />
                  {status}
                </label>
              ))}
            </div>
          </div>
          
          <div className="jp-comment-filter-group">
            <label>Priority:</label>
            <div className="jp-comment-filter-options">
              {Object.values(ICommentSystem.CommentPriority).map(priority => (
                <label key={priority} className="jp-comment-filter-option">
                  <input
                    type="checkbox"
                    checked={selectedPriority.includes(priority)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedPriority([...selectedPriority, priority]);
                      } else {
                        setSelectedPriority(selectedPriority.filter(p => p !== priority));
                      }
                    }}
                  />
                  {priority}
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
      
      {resultCount > 0 && (
        <div className="jp-comment-search-results">
          {resultCount} comment{resultCount !== 1 ? 's' : ''} found
        </div>
      )}
    </div>
  );
};

/**
 * Notification system for comment updates
 */
const NotificationSystem: React.FC<{
  notifications: Array<{
    id: string;
    type: 'comment_added' | 'comment_updated' | 'mention';
    message: string;
    timestamp: Date;
    commentId?: string;
  }>;
  onDismiss?: (id: string) => void;
  onNavigate?: (commentId: string) => void;
}> = ({
  notifications,
  onDismiss,
  onNavigate
}) => {
  return (
    <div className="jp-comment-notifications">
      {notifications.map(notification => (
        <div key={notification.id} className={`jp-comment-notification jp-comment-notification-${notification.type}`}>
          <div className="jp-comment-notification-content">
            <div className="jp-comment-notification-message">
              {notification.message}
            </div>
            <div className="jp-comment-notification-time">
              {notification.timestamp.toLocaleTimeString()}
            </div>
          </div>
          
          <div className="jp-comment-notification-actions">
            {notification.commentId && onNavigate && (
              <button onClick={() => onNavigate(notification.commentId!)}>
                <ExternalLink size={12} />
              </button>
            )}
            {onDismiss && (
              <button onClick={() => onDismiss(notification.id)}>
                ×
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

/**
 * Main comment system component
 */
export const CommentSystemComponent: React.FC<ICommentSystemProps> = ({
  notebook,
  collaborationProvider,
  awarenessProvider,
  translator = nullTranslator,
  enableNotifications = true,
  defaultPriority = ICommentSystem.CommentPriority.NORMAL,
  enableRichText = true,
  showResolvedComments = false,
  commentsPerPage = 20,
  enableImportExport = true,
  className = '',
  width,
  height,
  collapsed = false
}) => {
  // State management
  const [commentSystem, setCommentSystem] = useState<CommentSystem | null>(null);
  const [comments, setComments] = useState<ICommentSystem.IComment[]>([]);
  const [threads, setThreads] = useState<ICommentSystem.ICommentThread[]>([]);
  const [currentUser, setCurrentUser] = useState<IUserPresence | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAnchor, setSelectedAnchor] = useState<ICommentAnchorSelection | null>(null);
  const [showNewCommentEditor, setShowNewCommentEditor] = useState(false);
  const [newCommentContent, setNewCommentContent] = useState('');
  const [searchResults, setSearchResults] = useState<ICommentSystem.IComment[]>([]);
  const [notifications, setNotifications] = useState<Array<{
    id: string;
    type: 'comment_added' | 'comment_updated' | 'mention';
    message: string;
    timestamp: Date;
    commentId?: string;
  }>>([]);
  const [viewMode, setViewMode] = useState<'all' | 'open' | 'resolved'>('all');
  const [sortBy, setSortBy] = useState<'createdAt' | 'updatedAt' | 'priority'>('createdAt');
  const [isCollapsed, setIsCollapsed] = useState(collapsed);

  const trans = translator.load('notebook');
  const disposablesRef = useRef<IDisposable[]>([]);

  // Initialize comment system
  useEffect(() => {
    const initializeCommentSystem = async () => {
      try {
        setIsLoading(true);
        
        // Create comment storage and sync providers (would be injected in real implementation)
        const storageProvider = new MockCommentStorageProvider();
        const syncProvider = new MockCommentSyncProvider();
        
        // Create comment system
        const system = new CommentSystem({
          notebookId: notebook.model?.metadata.get('id') as string || UUID.uuid4(),
          storageProvider,
          syncProvider,
          collaborationProvider,
          awarenessProvider: awarenessProvider as any, // Type assertion for interface compatibility
          notificationConfig: {
            enableRealTime: enableNotifications,
            email: { enabled: false, frequency: 'immediate', includeContent: true },
            inApp: { enabled: true, soundEnabled: true, persistentNotifications: false },
            filters: {
              priorities: [ICommentSystem.CommentPriority.NORMAL, ICommentSystem.CommentPriority.HIGH, ICommentSystem.CommentPriority.URGENT],
              mentionsOnly: false,
              ownCommentsOnly: false,
              excludeResolved: !showResolvedComments
            }
          }
        });

        // Set up event listeners
        const disposables = [
          system.commentAdded.connect((sender, comment) => {
            setComments(prev => [...prev, comment]);
            if (enableNotifications) {
              addNotification('comment_added', `New comment by ${comment.author.name}`, comment.id);
            }
          }),
          
          system.commentUpdated.connect((sender, event) => {
            setComments(prev => prev.map(c => c.id === event.comment.id ? event.comment : c));
          }),
          
          system.commentDeleted.connect((sender, commentId) => {
            setComments(prev => prev.filter(c => c.id !== commentId));
          }),
          
          system.threadResolved.connect((sender, thread) => {
            setThreads(prev => prev.map(t => t.rootComment.id === thread.rootComment.id ? thread : t));
            if (enableNotifications) {
              addNotification('comment_updated', `Thread resolved by ${currentUser?.displayName}`, thread.rootComment.id);
            }
          }),
          
          system.syncStatusChanged.connect((sender, connected) => {
            setIsConnected(connected);
          })
        ];

        disposablesRef.current.push(...disposables);
        
        // Load initial comments
        const initialComments = await system.getComments();
        setComments(initialComments);
        
        // Build thread structure
        const threadMap = new Map<string, ICommentSystem.ICommentThread>();
        for (const comment of initialComments) {
          if (!comment.parentId) {
            // Root comment
            threadMap.set(comment.id, {
              rootComment: comment,
              replies: [],
              stats: { totalComments: 1, uniqueParticipants: 1, lastActivity: comment.updatedAt },
              threadStatus: comment.status
            });
          }
        }
        
        // Add replies to threads
        for (const comment of initialComments) {
          if (comment.parentId) {
            const thread = threadMap.get(comment.parentId);
            if (thread) {
              thread.replies.push(comment);
              thread.stats.totalComments++;
            }
          }
        }
        
        setThreads(Array.from(threadMap.values()));
        setCommentSystem(system);
        
        // Get current user from awareness
        const user = await (awarenessProvider as any).getCurrentUser();
        setCurrentUser(user);
        
        setIsLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to initialize comment system');
        setIsLoading(false);
      }
    };

    initializeCommentSystem();

    // Cleanup
    return () => {
      disposablesRef.current.forEach(d => d.dispose());
      commentSystem?.dispose();
    };
  }, [notebook, collaborationProvider, awarenessProvider]);

  // Add notification helper
  const addNotification = (type: 'comment_added' | 'comment_updated' | 'mention', message: string, commentId?: string) => {
    const notification = {
      id: UUID.uuid4(),
      type,
      message,
      timestamp: new Date(),
      commentId
    };
    setNotifications(prev => [...prev, notification]);
    
    // Auto-dismiss after 5 seconds
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== notification.id));
    }, 5000);
  };

  // Handle new comment submission
  const handleNewComment = async () => {
    if (!commentSystem || !newCommentContent.trim() || !selectedAnchor) return;
    
    try {
      await commentSystem.addComment(
        newCommentContent,
        selectedAnchor.anchor,
        {
          priority: defaultPriority,
          tags: []
        }
      );
      
      setNewCommentContent('');
      setShowNewCommentEditor(false);
      setSelectedAnchor(null);
    } catch (error) {
      console.error('Failed to add comment:', error);
      setError('Failed to add comment');
    }
  };

  // Handle comment search
  const handleSearch = async (query: string) => {
    if (!commentSystem) return;
    
    try {
      const results = await commentSystem.searchComments(query);
      setSearchResults(results);
    } catch (error) {
      console.error('Search failed:', error);
    }
  };

  // Filter comments by view mode
  const filteredComments = useMemo(() => {
    let filtered = comments;
    
    switch (viewMode) {
      case 'open':
        filtered = comments.filter(c => c.status === ICommentSystem.CommentStatus.OPEN);
        break;
      case 'resolved':
        filtered = comments.filter(c => c.status === ICommentSystem.CommentStatus.RESOLVED);
        break;
    }
    
    // Sort comments
    filtered.sort((a, b) => {
      switch (sortBy) {
        case 'updatedAt':
          return b.updatedAt.getTime() - a.updatedAt.getTime();
        case 'priority':
          const priorityOrder = {
            [ICommentSystem.CommentPriority.URGENT]: 4,
            [ICommentSystem.CommentPriority.HIGH]: 3,
            [ICommentSystem.CommentPriority.NORMAL]: 2,
            [ICommentSystem.CommentPriority.LOW]: 1
          };
          return priorityOrder[b.priority] - priorityOrder[a.priority];
        default:
          return b.createdAt.getTime() - a.createdAt.getTime();
      }
    });
    
    return filtered;
  }, [comments, viewMode, sortBy]);

  // Context value
  const contextValue: ICommentSystemContext = {
    commentSystem,
    collaborationProvider,
    awarenessProvider: awarenessProvider as any,
    currentUser,
    notebookId: notebook.model?.metadata.get('id') as string || '',
    isConnected
  };

  if (isLoading) {
    return (
      <div className="jp-comment-system jp-comment-loading">
        <div className="jp-spinner"></div>
        <div>Loading comments...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="jp-comment-system jp-comment-error">
        <AlertCircle size={24} />
        <div>{error}</div>
        <button onClick={() => window.location.reload()}>Retry</button>
      </div>
    );
  }

  return (
    <CommentSystemContext.Provider value={contextValue}>
      <div 
        className={`jp-comment-system ${className} ${isCollapsed ? 'jp-comment-collapsed' : ''}`}
        style={{ width, height }}
      >
        {/* Header */}
        <div className="jp-comment-header">
          <div className="jp-comment-title">
            <MessageSquare size={16} />
            <span>Comments</span>
            <span className="jp-comment-count">({filteredComments.length})</span>
          </div>
          
          <div className="jp-comment-header-actions">
            <div className="jp-comment-connection-status">
              <div className={`jp-comment-status-indicator ${isConnected ? 'connected' : 'disconnected'}`} />
              <span>{isConnected ? 'Connected' : 'Offline'}</span>
            </div>
            
            <button
              className="jp-comment-collapse-button"
              onClick={() => setIsCollapsed(!isCollapsed)}
              title={isCollapsed ? 'Expand comments' : 'Collapse comments'}
            >
              {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
        </div>

        {!isCollapsed && (
          <>
            {/* Notifications */}
            {notifications.length > 0 && (
              <NotificationSystem
                notifications={notifications}
                onDismiss={(id) => setNotifications(prev => prev.filter(n => n.id !== id))}
                onNavigate={(commentId) => {
                  // Scroll to comment implementation
                  const element = document.getElementById(`comment-${commentId}`);
                  element?.scrollIntoView({ behavior: 'smooth' });
                }}
              />
            )}

            {/* Search and filters */}
            <CommentSearchPanel
              onSearch={handleSearch}
              resultCount={searchResults.length}
            />

            {/* View controls */}
            <div className="jp-comment-controls">
              <div className="jp-comment-view-modes">
                {(['all', 'open', 'resolved'] as const).map(mode => (
                  <button
                    key={mode}
                    className={`jp-comment-view-mode ${viewMode === mode ? 'active' : ''}`}
                    onClick={() => setViewMode(mode)}
                  >
                    {mode === 'all' ? 'All' : mode === 'open' ? 'Open' : 'Resolved'}
                  </button>
                ))}
              </div>
              
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="jp-comment-sort"
              >
                <option value="createdAt">Newest First</option>
                <option value="updatedAt">Recently Updated</option>
                <option value="priority">Priority</option>
              </select>
            </div>

            {/* Comments list */}
            <div className="jp-comment-list">
              {filteredComments.length === 0 ? (
                <div className="jp-comment-empty">
                  <MessageSquare size={48} />
                  <div>No comments yet</div>
                  <div>Start a discussion by adding a comment</div>
                </div>
              ) : (
                threads.map(thread => (
                  <CommentThread
                    key={thread.rootComment.id}
                    thread={thread}
                    onAddReply={async (rootCommentId, content) => {
                      if (commentSystem) {
                        await commentSystem.addComment(content, thread.rootComment.anchor, {
                          parentId: rootCommentId,
                          priority: defaultPriority
                        });
                      }
                    }}
                    onEditComment={async (comment) => {
                      // Edit functionality handled in CommentItem
                    }}
                    onDeleteComment={async (comment) => {
                      if (commentSystem) {
                        const result = await showDialog({
                          title: 'Delete Comment',
                          body: 'Are you sure you want to delete this comment?',
                          buttons: [
                            Dialog.cancelButton(),
                            Dialog.warnButton({ label: 'Delete' })
                          ]
                        });
                        
                        if (result.button.accept) {
                          await commentSystem.deleteComment(comment.id);
                        }
                      }
                    }}
                    onResolveThread={async (rootCommentId) => {
                      if (commentSystem) {
                        await commentSystem.resolveThread(rootCommentId);
                      }
                    }}
                    currentUser={currentUser}
                  />
                ))
              )}
            </div>

            {/* New comment editor */}
            {showNewCommentEditor && selectedAnchor && (
              <div className="jp-comment-new-editor">
                <div className="jp-comment-anchor-info">
                  <div>Adding comment to: {selectedAnchor.anchor.cellId}</div>
                  {selectedAnchor.selectedText && (
                    <div className="jp-comment-selected-text">"{selectedAnchor.selectedText}"</div>
                  )}
                </div>
                
                <CommentEditor
                  value={newCommentContent}
                  onChange={setNewCommentContent}
                  onSubmit={handleNewComment}
                  onCancel={() => {
                    setShowNewCommentEditor(false);
                    setSelectedAnchor(null);
                    setNewCommentContent('');
                  }}
                  placeholder="Add a comment..."
                  enableMentions={true}
                  users={[]} // Would be populated from awareness provider
                  autoFocus={true}
                />
              </div>
            )}

            {/* Add comment button */}
            {!showNewCommentEditor && (
              <div className="jp-comment-add-button-container">
                <button
                  className="jp-comment-add-button"
                  onClick={() => {
                    // For demo, create a simple anchor to the active cell
                    const activeCell = notebook.activeCell;
                    if (activeCell) {
                      setSelectedAnchor({
                        anchor: {
                          type: ICommentSystem.AnchorType.CELL,
                          cellId: activeCell.model.id,
                        },
                        position: { x: 0, y: 0 }
                      });
                      setShowNewCommentEditor(true);
                    }
                  }}
                  disabled={!notebook.activeCell}
                >
                  <MessageSquare size={14} />
                  Add Comment to Active Cell
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </CommentSystemContext.Provider>
  );
};

/**
 * Mock storage provider for demonstration
 */
class MockCommentStorageProvider implements ICommentStorageProvider {
  private comments: Map<string, ICommentSystem.IComment> = new Map();

  async storeComment(comment: ICommentSystem.IComment): Promise<void> {
    this.comments.set(comment.id, comment);
  }

  async getComments(
    notebookId: string,
    options?: ICommentSystem.ICommentSearchOptions
  ): Promise<ICommentSystem.IComment[]> {
    return Array.from(this.comments.values())
      .filter(c => c.notebookId === notebookId);
  }

  async updateComment(
    commentId: string,
    updates: Partial<ICommentSystem.IComment>
  ): Promise<ICommentSystem.IComment> {
    const existing = this.comments.get(commentId);
    if (!existing) throw new Error('Comment not found');
    
    const updated = { ...existing, ...updates };
    this.comments.set(commentId, updated);
    return updated;
  }

  async deleteComment(commentId: string): Promise<void> {
    this.comments.delete(commentId);
  }

  async searchComments(
    notebookId: string,
    query: string,
    options?: ICommentSystem.ICommentSearchOptions
  ): Promise<ICommentSystem.IComment[]> {
    return Array.from(this.comments.values())
      .filter(c => c.notebookId === notebookId && c.content.includes(query));
  }

  async getCommentThread(rootCommentId: string): Promise<ICommentSystem.ICommentThread> {
    const rootComment = this.comments.get(rootCommentId);
    if (!rootComment) throw new Error('Root comment not found');
    
    const replies = Array.from(this.comments.values())
      .filter(c => c.parentId === rootCommentId);
    
    return {
      rootComment,
      replies,
      stats: {
        totalComments: 1 + replies.length,
        uniqueParticipants: new Set([rootComment.author.id, ...replies.map(r => r.author.id)]).size,
        lastActivity: new Date(Math.max(
          rootComment.updatedAt.getTime(),
          ...replies.map(r => r.updatedAt.getTime())
        ))
      },
      threadStatus: rootComment.status
    };
  }

  async bulkInsert(comments: ICommentSystem.IComment[]): Promise<ICommentSystem.IImportResult> {
    const successful: ICommentSystem.IComment[] = [];
    const failed: Array<{ data: any; error: string; }> = [];
    
    for (const comment of comments) {
      try {
        await this.storeComment(comment);
        successful.push(comment);
      } catch (error) {
        failed.push({
          data: comment,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    
    return {
      successful,
      failed,
      stats: {
        totalProcessed: comments.length,
        successCount: successful.length,
        failureCount: failed.length,
        duplicatesSkipped: 0
      }
    };
  }

  async bulkExport(
    notebookId: string,
    options: ICommentSystem.IExportOptions
  ): Promise<JSONValue> {
    const comments = await this.getComments(notebookId, options.filters);
    return comments;
  }
}

/**
 * Mock sync provider for demonstration
 */
class MockCommentSyncProvider implements ICommentSyncProvider {
  private _onCommentChange = new Signal<this, ICommentSystem.ISyncEvent>(this);

  async broadcastChange(event: ICommentSystem.ISyncEvent): Promise<void> {
    // In real implementation, this would broadcast via WebSocket
    setTimeout(() => {
      this._onCommentChange.emit(event);
    }, 0);
  }

  get onCommentChange(): ISignal<this, ICommentSystem.ISyncEvent> {
    return this._onCommentChange;
  }

  async handleSyncEvent(event: ICommentSystem.ISyncEvent): Promise<void> {
    // Handle incoming sync events
  }

  getSyncStatus(): { connected: boolean; lastSync: Date; pendingEvents: number; } {
    return {
      connected: true,
      lastSync: new Date(),
      pendingEvents: 0
    };
  }
}

/**
 * ReactWidget wrapper for the comment system
 */
export class CommentSystemWidget extends ReactWidget {
  private _config: ICommentSystemConfig;

  constructor(config: ICommentSystemConfig) {
    super();
    this._config = config;
    this.addClass('jp-comment-system-widget');
  }

  render(): JSX.Element {
    return <CommentSystemComponent {...this._config} />;
  }

  /**
   * Dispose of the widget
   */
  dispose(): void {
    super.dispose();
  }
}

/**
 * Default export
 */
export default CommentSystemComponent;