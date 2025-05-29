import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ReactWidget } from '@jupyterlab/ui-components';
import { INotebookShell } from '@jupyter-notebook/application';
import { INotebookModel } from '@jupyterlab/notebook';
import { Token } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';
import { Message } from '@lumino/messaging';

// Import collaboration modules
import { 
  IAwarenessRegistry, 
  IAwarenessManager, 
  IYjsNotebookProvider 
} from '@jupyter-notebook/application';

/**
 * Interface for user presence state information
 */
interface IUserPresenceState {
  /**
   * User's unique identifier
   */
  id: string;
  
  /**
   * User's display name
   */
  name: string;
  
  /**
   * User's avatar URL or identifier
   */
  avatar?: string;
  
  /**
   * User's assigned color for cursors and selections
   */
  color: string;
  
  /**
   * Current cursor position in the document
   */
  cursor?: {
    cellId: string;
    position: number;
    cellType?: 'code' | 'markdown' | 'raw';
  };
  
  /**
   * Current text selection range
   */
  selection?: {
    cellId: string;
    start: number;
    end: number;
  };
  
  /**
   * User's current status
   */
  status: 'active' | 'idle' | 'away' | 'offline';
  
  /**
   * Timestamp of last activity
   */
  lastSeen: number;
  
  /**
   * Current scroll/view position
   */
  viewPosition?: {
    scrollTop: number;
    cellInView?: string;
  };
  
  /**
   * User's role in the collaboration session
   */
  role?: 'owner' | 'editor' | 'viewer';
  
  /**
   * Whether the user is currently typing/editing
   */
  isTyping?: boolean;
  
  /**
   * What the user is currently working on
   */
  currentActivity?: string;
}

/**
 * Interface for cursor position overlay
 */
interface ICursorOverlay {
  id: string;
  user: IUserPresenceState;
  element: HTMLElement;
  position: { top: number; left: number };
  visible: boolean;
}

/**
 * Props interface for the UserPresence component
 */
interface IUserPresenceProps {
  shell: INotebookShell;
  notebook?: INotebookModel;
  yjsProvider?: IYjsNotebookProvider;
  awarenessManager?: IAwarenessManager;
  awarenessRegistry?: IAwarenessRegistry;
  currentUserId?: string;
  currentUserInfo?: Partial<IUserPresenceState>;
  showCursors?: boolean;
  showAvatars?: boolean;
  maxVisibleUsers?: number;
  onUserClick?: (user: IUserPresenceState) => void;
  onUserHover?: (user: IUserPresenceState | null) => void;
}

/**
 * Default user colors for presence indicators
 */
const DEFAULT_USER_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8',
  '#F7DC6F', '#BB8FCE', '#85C1E9', '#F8C471', '#82E0AA',
  '#F1948A', '#85C1E9', '#F4D03F', '#AED6F1', '#A9DFBF'
];

/**
 * UserPresence component for displaying real-time user presence and awareness
 */
const UserPresence: React.FC<IUserPresenceProps> = ({
  shell,
  notebook,
  yjsProvider,
  awarenessManager,
  awarenessRegistry,
  currentUserId,
  currentUserInfo,
  showCursors = true,
  showAvatars = true,
  maxVisibleUsers = 8,
  onUserClick,
  onUserHover
}) => {
  // Core state management
  const [activeUsers, setActiveUsers] = useState<Map<string, IUserPresenceState>>(new Map());
  const [currentUser, setCurrentUser] = useState<IUserPresenceState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  
  // UI state management
  const [cursorOverlays, setCursorOverlays] = useState<Map<string, ICursorOverlay>>(new Map());
  const [hoveredUser, setHoveredUser] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [lastUpdateTime, setLastUpdateTime] = useState<Date | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'connecting' | 'disconnected'>('connecting');
  
  // Refs for DOM manipulation and cleanup
  const presenceContainerRef = useRef<HTMLDivElement>(null);
  const cursorUpdateTimeoutRef = useRef<number | null>(null);
  const userActivityTimeoutRef = useRef<Map<string, number>>(new Map());
  const localStateUpdateTimeoutRef = useRef<number | null>(null);
  
  /**
   * Generate a user color based on user ID
   */
  const generateUserColor = useCallback((userId: string): string => {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = userId.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % DEFAULT_USER_COLORS.length;
    return DEFAULT_USER_COLORS[index];
  }, []);

  /**
   * Create default user state
   */
  const createUserState = useCallback((userId: string, partialState: Partial<IUserPresenceState> = {}): IUserPresenceState => {
    return {
      id: userId,
      name: `User ${userId.slice(-4)}`,
      color: generateUserColor(userId),
      status: 'active',
      lastSeen: Date.now(),
      role: 'editor',
      isTyping: false,
      ...partialState
    };
  }, [generateUserColor]);

  /**
   * Update local user state in awareness
   */
  const updateLocalState = useCallback((updates: Partial<IUserPresenceState>) => {
    if (!awarenessManager || !currentUserId) {
      return;
    }

    try {
      // Debounce local state updates to prevent excessive network traffic
      if (localStateUpdateTimeoutRef.current) {
        clearTimeout(localStateUpdateTimeoutRef.current);
      }

      localStateUpdateTimeoutRef.current = window.setTimeout(() => {
        const currentState = currentUser || createUserState(currentUserId, currentUserInfo);
        const newState = { ...currentState, ...updates, lastSeen: Date.now() };
        
        awarenessManager.updateLocalState(newState);
        setCurrentUser(newState);
        setLastUpdateTime(new Date());
      }, 100); // 100ms debounce
    } catch (error) {
      console.error('Failed to update local state:', error);
      setErrorMessage('Failed to update presence information');
    }
  }, [awarenessManager, currentUserId, currentUser, currentUserInfo, createUserState]);

  /**
   * Track cursor position and update awareness
   */
  const trackCursorPosition = useCallback(() => {
    if (!notebook || !currentUserId) {
      return;
    }

    try {
      // Get current cell and cursor position from the notebook
      const activeCell = notebook.content.activeCell;
      if (activeCell) {
        const cellId = activeCell.model.id;
        const editor = activeCell.editor;
        
        if (editor) {
          const cursorPosition = editor.getCursorPosition();
          const selection = editor.getSelection();
          
          const cursorInfo: IUserPresenceState['cursor'] = {
            cellId,
            position: cursorPosition ? cursorPosition.column : 0,
            cellType: activeCell.model.type as 'code' | 'markdown' | 'raw'
          };

          const selectionInfo: IUserPresenceState['selection'] = selection ? {
            cellId,
            start: selection.start.column,
            end: selection.end.column
          } : undefined;

          updateLocalState({
            cursor: cursorInfo,
            selection: selectionInfo,
            status: 'active',
            isTyping: true,
            currentActivity: `Editing ${activeCell.model.type} cell`
          });

          // Clear typing indicator after delay
          if (cursorUpdateTimeoutRef.current) {
            clearTimeout(cursorUpdateTimeoutRef.current);
          }
          
          cursorUpdateTimeoutRef.current = window.setTimeout(() => {
            updateLocalState({
              isTyping: false,
              currentActivity: undefined
            });
          }, 3000);
        }
      }
    } catch (error) {
      console.error('Failed to track cursor position:', error);
    }
  }, [notebook, currentUserId, updateLocalState]);

  /**
   * Track scroll/view position
   */
  const trackViewPosition = useCallback(() => {
    if (!notebook || !currentUserId) {
      return;
    }

    try {
      const notebookPanel = notebook.content;
      const scrollTop = notebookPanel.node.scrollTop;
      
      // Find the cell currently in view
      const cells = notebookPanel.widgets;
      let cellInView = '';
      
      for (const cell of cells) {
        const cellRect = cell.node.getBoundingClientRect();
        const panelRect = notebookPanel.node.getBoundingClientRect();
        
        if (cellRect.top <= panelRect.top + 100 && cellRect.bottom >= panelRect.top + 100) {
          cellInView = cell.model.id;
          break;
        }
      }

      updateLocalState({
        viewPosition: {
          scrollTop,
          cellInView
        },
        status: 'active'
      });
    } catch (error) {
      console.error('Failed to track view position:', error);
    }
  }, [notebook, currentUserId, updateLocalState]);

  /**
   * Handle awareness state changes from other users
   */
  const handleAwarenessChange = useCallback((users: Map<string, IAwarenessRegistry.IAwarenessState>) => {
    try {
      const newActiveUsers = new Map<string, IUserPresenceState>();
      
      users.forEach((state, userId) => {
        if (userId !== currentUserId && state) {
          const userState: IUserPresenceState = {
            id: userId,
            name: state.name || `User ${userId.slice(-4)}`,
            avatar: state.avatar,
            color: state.color || generateUserColor(userId),
            cursor: state.cursor,
            selection: state.selection,
            status: state.status || 'active',
            lastSeen: state.lastSeen || Date.now(),
            role: (state as any).role || 'editor',
            isTyping: (state as any).isTyping || false,
            currentActivity: (state as any).currentActivity,
            viewPosition: (state as any).viewPosition
          };
          
          newActiveUsers.set(userId, userState);
          
          // Update activity timeout for this user
          const existingTimeout = userActivityTimeoutRef.current.get(userId);
          if (existingTimeout) {
            clearTimeout(existingTimeout);
          }
          
          // Mark user as idle after 5 minutes of inactivity
          const timeoutId = window.setTimeout(() => {
            setActiveUsers(prev => {
              const updated = new Map(prev);
              const user = updated.get(userId);
              if (user) {
                updated.set(userId, { ...user, status: 'idle' });
              }
              return updated;
            });
          }, 300000); // 5 minutes
          
          userActivityTimeoutRef.current.set(userId, timeoutId);
        }
      });
      
      setActiveUsers(newActiveUsers);
      setLastUpdateTime(new Date());
      setConnectionStatus('connected');
      
      // Update cursor overlays if enabled
      if (showCursors) {
        updateCursorOverlays(newActiveUsers);
      }
    } catch (error) {
      console.error('Failed to handle awareness change:', error);
      setErrorMessage('Failed to update user presence');
    }
  }, [currentUserId, generateUserColor, showCursors]);

  /**
   * Update cursor overlays for remote users
   */
  const updateCursorOverlays = useCallback((users: Map<string, IUserPresenceState>) => {
    if (!notebook || !showCursors) {
      return;
    }

    try {
      const newOverlays = new Map<string, ICursorOverlay>();
      
      users.forEach((user, userId) => {
        if (user.cursor && user.status === 'active') {
          const cell = notebook.content.widgets.find(w => w.model.id === user.cursor!.cellId);
          if (cell) {
            const cellRect = cell.node.getBoundingClientRect();
            const editor = (cell as any).editor;
            
            if (editor) {
              // Calculate cursor position within the cell
              const position = { 
                top: cellRect.top + 20, // Approximate position
                left: cellRect.left + 10 + (user.cursor.position * 8) // Approximate character width
              };
              
              // Create cursor overlay element
              const cursorElement = document.createElement('div');
              cursorElement.className = 'jp-Collab-cursor-overlay';
              cursorElement.style.cssText = `
                position: fixed;
                top: ${position.top}px;
                left: ${position.left}px;
                width: 2px;
                height: 20px;
                background-color: ${user.color};
                pointer-events: none;
                z-index: 1000;
                animation: jp-Collab-cursor-blink 1s infinite;
              `;
              
              // Add user label
              const label = document.createElement('div');
              label.className = 'jp-Collab-cursor-label';
              label.textContent = user.name;
              label.style.cssText = `
                position: absolute;
                top: -25px;
                left: 0;
                background-color: ${user.color};
                color: white;
                padding: 2px 6px;
                border-radius: 3px;
                font-size: 11px;
                white-space: nowrap;
                transform: translateX(-50%);
              `;
              
              cursorElement.appendChild(label);
              
              newOverlays.set(userId, {
                id: userId,
                user,
                element: cursorElement,
                position,
                visible: true
              });
            }
          }
        }
      });
      
      setCursorOverlays(newOverlays);
    } catch (error) {
      console.error('Failed to update cursor overlays:', error);
    }
  }, [notebook, showCursors]);

  /**
   * Initialize awareness integration
   */
  useEffect(() => {
    if (!awarenessManager || !yjsProvider || !currentUserId) {
      setIsLoading(false);
      setHasError(true);
      setErrorMessage('Awareness provider not available');
      return;
    }

    setIsLoading(true);
    setHasError(false);
    setErrorMessage(null);

    try {
      // Initialize current user
      const initialUserState = createUserState(currentUserId, currentUserInfo);
      setCurrentUser(initialUserState);
      
      // Subscribe to awareness changes
      awarenessManager.onAwarenessChange(handleAwarenessChange);
      
      // Initialize local state
      awarenessManager.initialize(initialUserState);
      
      // Set up cursor and view tracking
      if (notebook) {
        const notebookContent = notebook.content;
        
        // Track cursor movements
        notebookContent.activeCellChanged.connect(() => {
          trackCursorPosition();
        });
        
        // Track scrolling
        notebookContent.node.addEventListener('scroll', trackViewPosition, { passive: true });
        
        // Track cell editing
        notebookContent.model.cells.changed.connect(() => {
          trackCursorPosition();
        });
      }
      
      setIsInitialized(true);
      setIsLoading(false);
      setConnectionStatus('connected');
      
    } catch (error) {
      console.error('Failed to initialize awareness:', error);
      setHasError(true);
      setErrorMessage(error instanceof Error ? error.message : 'Failed to initialize user presence');
      setIsLoading(false);
    }

    return () => {
      try {
        // Cleanup timeouts
        if (cursorUpdateTimeoutRef.current) {
          clearTimeout(cursorUpdateTimeoutRef.current);
        }
        if (localStateUpdateTimeoutRef.current) {
          clearTimeout(localStateUpdateTimeoutRef.current);
        }
        
        userActivityTimeoutRef.current.forEach(timeoutId => {
          clearTimeout(timeoutId);
        });
        userActivityTimeoutRef.current.clear();
        
        // Remove event listeners
        if (notebook) {
          notebook.content.node.removeEventListener('scroll', trackViewPosition);
        }
        
        // Cleanup cursor overlays
        cursorOverlays.forEach(overlay => {
          if (overlay.element.parentNode) {
            overlay.element.parentNode.removeChild(overlay.element);
          }
        });
        
        // Mark current user as offline
        if (awarenessManager && currentUserId) {
          awarenessManager.updateLocalState({ status: 'offline' } as any);
        }
      } catch (error) {
        console.error('Error during cleanup:', error);
      }
    };
  }, [awarenessManager, yjsProvider, currentUserId, currentUserInfo, notebook]);

  /**
   * Render cursor overlays in the DOM
   */
  useEffect(() => {
    if (!showCursors) {
      return;
    }

    // Remove old overlays
    document.querySelectorAll('.jp-Collab-cursor-overlay').forEach(el => {
      el.remove();
    });

    // Add new overlays
    cursorOverlays.forEach(overlay => {
      if (overlay.visible) {
        document.body.appendChild(overlay.element);
      }
    });

    return () => {
      // Cleanup on unmount
      document.querySelectorAll('.jp-Collab-cursor-overlay').forEach(el => {
        el.remove();
      });
    };
  }, [cursorOverlays, showCursors]);

  /**
   * Handle user avatar click
   */
  const handleUserClick = useCallback((user: IUserPresenceState) => {
    onUserClick?.(user);
    
    // Scroll to user's current position if available
    if (user.viewPosition?.cellInView && notebook) {
      const cell = notebook.content.widgets.find(w => w.model.id === user.viewPosition!.cellInView);
      if (cell) {
        cell.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [onUserClick, notebook]);

  /**
   * Handle user avatar hover
   */
  const handleUserHover = useCallback((userId: string | null) => {
    setHoveredUser(userId);
    const user = userId ? activeUsers.get(userId) : null;
    onUserHover?.(user || null);
  }, [activeUsers, onUserHover]);

  /**
   * Render user avatar with presence indicators
   */
  const renderUserAvatar = useCallback((user: IUserPresenceState, size: 'small' | 'medium' = 'small') => {
    const sizeClass = size === 'small' ? 'jp-Collab-presence-avatar-small' : 'jp-Collab-presence-avatar-medium';
    const initials = user.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    const isHovered = hoveredUser === user.id;
    const isTyping = user.isTyping && user.status === 'active';
    
    return (
      <div
        key={user.id}
        className={`jp-Collab-presence-avatar ${sizeClass} ${isHovered ? 'jp-Collab-presence-hovered' : ''}`}
        style={{ 
          backgroundColor: user.color,
          borderColor: user.status === 'active' ? '#10b981' : 
                       user.status === 'idle' ? '#f59e0b' : '#6b7280'
        }}
        title={`${user.name} (${user.role}) - ${user.status}${user.currentActivity ? ` - ${user.currentActivity}` : ''}`}
        onClick={() => handleUserClick(user)}
        onMouseEnter={() => handleUserHover(user.id)}
        onMouseLeave={() => handleUserHover(null)}
        aria-label={`${user.name}, ${user.status}${isTyping ? ', currently typing' : ''}`}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleUserClick(user);
          }
        }}
      >
        {user.avatar ? (
          <img src={user.avatar} alt={user.name} className="jp-Collab-presence-avatar-image" />
        ) : (
          <span className="jp-Collab-presence-avatar-initials">{initials}</span>
        )}
        
        {/* Status indicator */}
        <div 
          className={`jp-Collab-presence-status-indicator jp-Collab-presence-status-${user.status}`}
          aria-hidden="true"
        />
        
        {/* Typing indicator */}
        {isTyping && (
          <div 
            className="jp-Collab-presence-typing-indicator"
            aria-hidden="true"
            title="Currently typing"
          >
            <div className="jp-Collab-presence-typing-dot" />
            <div className="jp-Collab-presence-typing-dot" />
            <div className="jp-Collab-presence-typing-dot" />
          </div>
        )}
        
        {/* Role indicator for non-editors */}
        {user.role && user.role !== 'editor' && (
          <div 
            className={`jp-Collab-presence-role-indicator jp-Collab-presence-role-${user.role}`}
            title={`Role: ${user.role}`}
            aria-hidden="true"
          >
            {user.role === 'owner' ? '👑' : user.role === 'viewer' ? '👁️' : ''}
          </div>
        )}
      </div>
    );
  }, [hoveredUser, handleUserClick, handleUserHover]);

  /**
   * Render user details tooltip
   */
  const renderUserTooltip = useCallback((user: IUserPresenceState) => {
    if (hoveredUser !== user.id) {
      return null;
    }

    const timeSinceLastSeen = Date.now() - user.lastSeen;
    const lastSeenText = timeSinceLastSeen < 60000 ? 'Just now' : 
                        timeSinceLastSeen < 3600000 ? `${Math.floor(timeSinceLastSeen / 60000)}m ago` :
                        `${Math.floor(timeSinceLastSeen / 3600000)}h ago`;

    return (
      <div className="jp-Collab-presence-tooltip" role="tooltip">
        <div className="jp-Collab-presence-tooltip-header">
          <div className="jp-Collab-presence-tooltip-name">{user.name}</div>
          <div className="jp-Collab-presence-tooltip-role">{user.role}</div>
        </div>
        <div className="jp-Collab-presence-tooltip-details">
          <div>Status: <span className={`jp-Collab-presence-status-text-${user.status}`}>{user.status}</span></div>
          <div>Last seen: {lastSeenText}</div>
          {user.currentActivity && <div>Activity: {user.currentActivity}</div>}
          {user.cursor && (
            <div>Currently viewing: Cell {user.cursor.cellId.slice(-6)}</div>
          )}
        </div>
      </div>
    );
  }, [hoveredUser]);

  /**
   * Get active users list for display
   */
  const displayUsers = useMemo(() => {
    const users = Array.from(activeUsers.values())
      .filter(user => user.status !== 'offline')
      .sort((a, b) => {
        // Sort by status (active first), then by last seen
        if (a.status !== b.status) {
          if (a.status === 'active') return -1;
          if (b.status === 'active') return 1;
          if (a.status === 'idle') return -1;
          if (b.status === 'idle') return 1;
        }
        return b.lastSeen - a.lastSeen;
      });
    
    return users.slice(0, maxVisibleUsers);
  }, [activeUsers, maxVisibleUsers]);

  /**
   * Get overflow count for users not displayed
   */
  const overflowCount = useMemo(() => {
    const totalActiveUsers = Array.from(activeUsers.values())
      .filter(user => user.status !== 'offline').length;
    return Math.max(0, totalActiveUsers - maxVisibleUsers);
  }, [activeUsers, maxVisibleUsers]);

  // Show loading state
  if (isLoading) {
    return (
      <div className="jp-Collab-presence jp-Collab-presence-loading" role="status" aria-label="Loading user presence">
        <div className="jp-Collab-presence-loading-indicator">
          <div className="jp-Collab-presence-loading-spinner" />
          <span className="jp-Collab-presence-loading-text">Loading presence...</span>
        </div>
      </div>
    );
  }

  // Show error state
  if (hasError) {
    return (
      <div className="jp-Collab-presence jp-Collab-presence-error" role="alert">
        <div className="jp-Collab-presence-error-content">
          <span className="jp-Collab-presence-error-icon">⚠️</span>
          <span className="jp-Collab-presence-error-text">
            {errorMessage || 'User presence unavailable'}
          </span>
        </div>
      </div>
    );
  }

  // Main render
  return (
    <div 
      ref={presenceContainerRef}
      className="jp-Collab-presence"
      role="group"
      aria-label={`User presence: ${displayUsers.length} active user${displayUsers.length !== 1 ? 's' : ''}`}
    >
      {/* Connection status indicator */}
      <div 
        className={`jp-Collab-presence-connection jp-Collab-presence-connection-${connectionStatus}`}
        title={`Connection status: ${connectionStatus}`}
        aria-label={`Connection status: ${connectionStatus}`}
      >
        <div className="jp-Collab-presence-connection-dot" />
      </div>

      {/* User avatars */}
      <div className="jp-Collab-presence-users" role="list">
        {showAvatars && displayUsers.map(user => (
          <div key={user.id} role="listitem">
            {renderUserAvatar(user)}
            {renderUserTooltip(user)}
          </div>
        ))}
        
        {/* Overflow indicator */}
        {overflowCount > 0 && (
          <div 
            className="jp-Collab-presence-overflow"
            title={`+${overflowCount} more user${overflowCount !== 1 ? 's' : ''}`}
            aria-label={`${overflowCount} additional user${overflowCount !== 1 ? 's' : ''} not shown`}
          >
            +{overflowCount}
          </div>
        )}
      </div>

      {/* User count */}
      <div 
        className="jp-Collab-presence-count"
        aria-live="polite"
        aria-label={`${displayUsers.length} user${displayUsers.length !== 1 ? 's' : ''} active`}
      >
        {displayUsers.length} user{displayUsers.length !== 1 ? 's' : ''}
      </div>

      {/* Last update time (for debugging) */}
      {lastUpdateTime && process.env.NODE_ENV === 'development' && (
        <div className="jp-Collab-presence-debug">
          Updated: {lastUpdateTime.toLocaleTimeString()}
        </div>
      )}
    </div>
  );
};

/**
 * Widget wrapper for the UserPresence component
 */
export class UserPresenceWidget extends ReactWidget {
  private _shell: INotebookShell;
  private _notebook?: INotebookModel;
  private _yjsProvider?: IYjsNotebookProvider;
  private _awarenessManager?: IAwarenessManager;
  private _awarenessRegistry?: IAwarenessRegistry;
  private _currentUserId?: string;
  private _currentUserInfo?: Partial<IUserPresenceState>;
  private _showCursors: boolean = true;
  private _showAvatars: boolean = true;
  private _maxVisibleUsers: number = 8;
  private _userClicked = new Signal<this, IUserPresenceState>(this);
  private _userHovered = new Signal<this, IUserPresenceState | null>(this);

  constructor(options: {
    shell: INotebookShell;
    notebook?: INotebookModel;
    yjsProvider?: IYjsNotebookProvider;
    awarenessManager?: IAwarenessManager;
    awarenessRegistry?: IAwarenessRegistry;
    currentUserId?: string;
    currentUserInfo?: Partial<IUserPresenceState>;
  }) {
    super();
    this._shell = options.shell;
    this._notebook = options.notebook;
    this._yjsProvider = options.yjsProvider;
    this._awarenessManager = options.awarenessManager;
    this._awarenessRegistry = options.awarenessRegistry;
    this._currentUserId = options.currentUserId;
    this._currentUserInfo = options.currentUserInfo;
    this.addClass('jp-Collab-PresenceWidget');
  }

  /**
   * Signal emitted when a user avatar is clicked
   */
  get userClicked(): ISignal<this, IUserPresenceState> {
    return this._userClicked;
  }

  /**
   * Signal emitted when a user avatar is hovered
   */
  get userHovered(): ISignal<this, IUserPresenceState | null> {
    return this._userHovered;
  }

  /**
   * Update the notebook model
   */
  setNotebook(notebook: INotebookModel | undefined): void {
    this._notebook = notebook;
    this.update();
  }

  /**
   * Update the YjsNotebookProvider
   */
  setYjsProvider(provider: IYjsNotebookProvider | undefined): void {
    this._yjsProvider = provider;
    this.update();
  }

  /**
   * Update the awareness manager
   */
  setAwarenessManager(manager: IAwarenessManager | undefined): void {
    this._awarenessManager = manager;
    this.update();
  }

  /**
   * Update the awareness registry
   */
  setAwarenessRegistry(registry: IAwarenessRegistry | undefined): void {
    this._awarenessRegistry = registry;
    this.update();
  }

  /**
   * Update current user information
   */
  setCurrentUser(userId?: string, userInfo?: Partial<IUserPresenceState>): void {
    this._currentUserId = userId;
    this._currentUserInfo = userInfo;
    this.update();
  }

  /**
   * Configure display options
   */
  setDisplayOptions(options: {
    showCursors?: boolean;
    showAvatars?: boolean;
    maxVisibleUsers?: number;
  }): void {
    if (options.showCursors !== undefined) {
      this._showCursors = options.showCursors;
    }
    if (options.showAvatars !== undefined) {
      this._showAvatars = options.showAvatars;
    }
    if (options.maxVisibleUsers !== undefined) {
      this._maxVisibleUsers = options.maxVisibleUsers;
    }
    this.update();
  }

  protected render(): JSX.Element {
    return (
      <UserPresence
        shell={this._shell}
        notebook={this._notebook}
        yjsProvider={this._yjsProvider}
        awarenessManager={this._awarenessManager}
        awarenessRegistry={this._awarenessRegistry}
        currentUserId={this._currentUserId}
        currentUserInfo={this._currentUserInfo}
        showCursors={this._showCursors}
        showAvatars={this._showAvatars}
        maxVisibleUsers={this._maxVisibleUsers}
        onUserClick={(user) => this._userClicked.emit(user)}
        onUserHover={(user) => this._userHovered.emit(user)}
      />
    );
  }
}

/**
 * Token for the UserPresence service
 */
export const IUserPresence = new Token<IUserPresence>(
  '@jupyter-notebook/user-presence:IUserPresence'
);

/**
 * Interface for the UserPresence service
 */
export interface IUserPresence {
  /**
   * The user presence widget
   */
  readonly widget: UserPresenceWidget;

  /**
   * Signal emitted when a user avatar is clicked
   */
  readonly userClicked: ISignal<UserPresenceWidget, IUserPresenceState>;

  /**
   * Signal emitted when a user avatar is hovered
   */
  readonly userHovered: ISignal<UserPresenceWidget, IUserPresenceState | null>;
}

export default UserPresence;

/**
 * CSS Styles for the UserPresence component
 * These styles should be included in the extension's CSS bundle
 */
export const USER_PRESENCE_CSS = `
/* Main user presence container */
.jp-Collab-presence {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  background: var(--jp-layout-color1);
  border-radius: 6px;
  font-size: var(--jp-ui-font-size1);
  min-height: 32px;
  position: relative;
  transition: all 0.2s ease;
  border: 1px solid transparent;
}

.jp-Collab-presence:hover {
  background: var(--jp-layout-color2);
  border-color: var(--jp-border-color1);
}

/* Connection status indicator */
.jp-Collab-presence-connection {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  flex-shrink: 0;
}

.jp-Collab-presence-connection-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  transition: background-color 0.2s ease;
}

.jp-Collab-presence-connection-connected .jp-Collab-presence-connection-dot {
  background-color: #10b981;
  animation: jp-Collab-presence-pulse 2s infinite;
}

.jp-Collab-presence-connection-connecting .jp-Collab-presence-connection-dot {
  background-color: #f59e0b;
  animation: jp-Collab-presence-blink 1s infinite;
}

.jp-Collab-presence-connection-disconnected .jp-Collab-presence-connection-dot {
  background-color: #ef4444;
}

/* User avatars container */
.jp-Collab-presence-users {
  display: flex;
  align-items: center;
  gap: -6px; /* Slight overlap for compact display */
  flex-wrap: nowrap;
  overflow: hidden;
}

/* Individual user avatar */
.jp-Collab-presence-avatar {
  border-radius: 50%;
  border: 2px solid transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: 600;
  position: relative;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  z-index: 1;
  flex-shrink: 0;
}

.jp-Collab-presence-avatar:hover,
.jp-Collab-presence-hovered {
  transform: scale(1.15);
  z-index: 10;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.jp-Collab-presence-avatar:focus {
  outline: 2px solid var(--jp-brand-color1);
  outline-offset: 2px;
}

.jp-Collab-presence-avatar-small {
  width: 28px;
  height: 28px;
  font-size: 11px;
}

.jp-Collab-presence-avatar-medium {
  width: 36px;
  height: 36px;
  font-size: 13px;
}

.jp-Collab-presence-avatar-image {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}

.jp-Collab-presence-avatar-initials {
  font-weight: 600;
  text-transform: uppercase;
}

/* Status indicators */
.jp-Collab-presence-status-indicator {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 10px;
  height: 10px;
  border: 2px solid var(--jp-layout-color1);
  border-radius: 50%;
  z-index: 11;
}

.jp-Collab-presence-status-active {
  background: #10b981;
}

.jp-Collab-presence-status-idle {
  background: #f59e0b;
}

.jp-Collab-presence-status-away {
  background: #6b7280;
}

.jp-Collab-presence-status-offline {
  background: #ef4444;
}

/* Typing indicator */
.jp-Collab-presence-typing-indicator {
  position: absolute;
  top: -8px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 2px;
  align-items: center;
  background: var(--jp-layout-color1);
  border: 1px solid var(--jp-border-color1);
  border-radius: 8px;
  padding: 2px 4px;
  z-index: 12;
}

.jp-Collab-presence-typing-dot {
  width: 3px;
  height: 3px;
  background: var(--jp-ui-font-color1);
  border-radius: 50%;
  animation: jp-Collab-presence-typing 1.4s infinite ease-in-out both;
}

.jp-Collab-presence-typing-dot:nth-child(1) {
  animation-delay: -0.32s;
}

.jp-Collab-presence-typing-dot:nth-child(2) {
  animation-delay: -0.16s;
}

/* Role indicators */
.jp-Collab-presence-role-indicator {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 16px;
  height: 16px;
  background: var(--jp-layout-color1);
  border: 1px solid var(--jp-border-color1);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 8px;
  z-index: 12;
}

.jp-Collab-presence-role-owner {
  background: #f59e0b;
  color: white;
  border-color: #f59e0b;
}

.jp-Collab-presence-role-viewer {
  background: #6b7280;
  color: white;
  border-color: #6b7280;
}

/* Overflow indicator */
.jp-Collab-presence-overflow {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--jp-ui-font-color2);
  color: var(--jp-layout-color1);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  border: 2px solid var(--jp-border-color1);
  cursor: default;
  flex-shrink: 0;
}

/* User count */
.jp-Collab-presence-count {
  font-size: 11px;
  color: var(--jp-ui-font-color2);
  white-space: nowrap;
  font-weight: 500;
}

/* User tooltip */
.jp-Collab-presence-tooltip {
  position: fixed;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  margin-bottom: 8px;
  background: var(--jp-layout-color0);
  border: 1px solid var(--jp-border-color1);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  padding: 8px 12px;
  min-width: 200px;
  z-index: 2000;
  font-size: 12px;
  line-height: 1.4;
  pointer-events: none;
  animation: jp-Collab-presence-tooltip-appear 0.2s ease-out;
}

.jp-Collab-presence-tooltip::before {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 6px solid transparent;
  border-top-color: var(--jp-border-color1);
}

.jp-Collab-presence-tooltip::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  margin-top: -1px;
  border: 5px solid transparent;
  border-top-color: var(--jp-layout-color0);
}

.jp-Collab-presence-tooltip-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--jp-border-color2);
}

.jp-Collab-presence-tooltip-name {
  font-weight: 600;
  color: var(--jp-ui-font-color1);
}

.jp-Collab-presence-tooltip-role {
  font-size: 10px;
  color: var(--jp-ui-font-color2);
  text-transform: uppercase;
  font-weight: 500;
}

.jp-Collab-presence-tooltip-details {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.jp-Collab-presence-tooltip-details div {
  font-size: 11px;
  color: var(--jp-ui-font-color2);
}

.jp-Collab-presence-status-text-active {
  color: #10b981;
  font-weight: 500;
}

.jp-Collab-presence-status-text-idle {
  color: #f59e0b;
  font-weight: 500;
}

.jp-Collab-presence-status-text-away {
  color: #6b7280;
  font-weight: 500;
}

.jp-Collab-presence-status-text-offline {
  color: #ef4444;
  font-weight: 500;
}

/* Cursor overlays */
.jp-Collab-cursor-overlay {
  position: fixed;
  pointer-events: none;
  z-index: 1000;
  transition: opacity 0.2s ease;
}

.jp-Collab-cursor-label {
  position: absolute;
  top: -25px;
  left: 0;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  transform: translateX(-50%);
  color: white;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

/* Loading state */
.jp-Collab-presence-loading {
  justify-content: center;
  opacity: 0.8;
}

.jp-Collab-presence-loading-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
}

.jp-Collab-presence-loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--jp-border-color2);
  border-top-color: var(--jp-brand-color1);
  border-radius: 50%;
  animation: jp-Collab-presence-spin 1s linear infinite;
}

.jp-Collab-presence-loading-text {
  font-size: 11px;
  color: var(--jp-ui-font-color2);
}

/* Error state */
.jp-Collab-presence-error {
  background: var(--jp-warn-color3);
  border-color: var(--jp-warn-color1);
}

.jp-Collab-presence-error-content {
  display: flex;
  align-items: center;
  gap: 6px;
}

.jp-Collab-presence-error-icon {
  font-size: 14px;
}

.jp-Collab-presence-error-text {
  font-size: 11px;
  color: var(--jp-warn-color1);
}

/* Debug information */
.jp-Collab-presence-debug {
  font-size: 9px;
  color: var(--jp-ui-font-color2);
  opacity: 0.6;
  position: absolute;
  bottom: -16px;
  right: 0;
  white-space: nowrap;
}

/* Widget wrapper */
.jp-Collab-PresenceWidget {
  flex-shrink: 0;
}

/* Animations */
@keyframes jp-Collab-presence-pulse {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.7;
    transform: scale(1.1);
  }
}

@keyframes jp-Collab-presence-blink {
  0%, 50% {
    opacity: 1;
  }
  51%, 100% {
    opacity: 0.3;
  }
}

@keyframes jp-Collab-cursor-blink {
  0%, 50% {
    opacity: 1;
  }
  51%, 100% {
    opacity: 0;
  }
}

@keyframes jp-Collab-presence-typing {
  0%, 80%, 100% {
    transform: scale(0);
    opacity: 0.5;
  }
  40% {
    transform: scale(1);
    opacity: 1;
  }
}

@keyframes jp-Collab-presence-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@keyframes jp-Collab-presence-tooltip-appear {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}

/* Responsive design */
@media (max-width: 768px) {
  .jp-Collab-presence {
    gap: 8px;
    padding: 4px 8px;
  }
  
  .jp-Collab-presence-users {
    gap: -4px;
  }
  
  .jp-Collab-presence-avatar-small {
    width: 24px;
    height: 24px;
    font-size: 10px;
  }
  
  .jp-Collab-presence-count {
    display: none;
  }
  
  .jp-Collab-presence-tooltip {
    min-width: 180px;
    font-size: 11px;
  }
}

@media (max-width: 480px) {
  .jp-Collab-presence {
    gap: 4px;
    padding: 2px 6px;
  }
  
  .jp-Collab-presence-avatar-small {
    width: 20px;
    height: 20px;
    font-size: 9px;
  }
  
  .jp-Collab-presence-overflow {
    width: 20px;
    height: 20px;
    font-size: 8px;
  }
  
  .jp-Collab-presence-tooltip {
    position: fixed;
    top: 60px;
    left: 50%;
    bottom: auto;
    transform: translateX(-50%);
    margin-bottom: 0;
    max-width: 90vw;
  }
  
  .jp-Collab-presence-tooltip::before,
  .jp-Collab-presence-tooltip::after {
    top: -11px;
    border-top-color: transparent;
    border-bottom-color: var(--jp-border-color1);
  }
  
  .jp-Collab-presence-tooltip::after {
    margin-top: 1px;
    border-bottom-color: var(--jp-layout-color0);
  }
}

/* Dark theme support */
[data-jp-theme-light="false"] .jp-Collab-presence-status-indicator {
  border-color: var(--jp-layout-color0);
}

[data-jp-theme-light="false"] .jp-Collab-presence-tooltip {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

[data-jp-theme-light="false"] .jp-Collab-cursor-overlay {
  filter: brightness(1.2);
}

/* High contrast mode support */
@media (prefers-contrast: high) {
  .jp-Collab-presence {
    border-width: 2px;
  }
  
  .jp-Collab-presence-avatar {
    border-width: 3px;
  }
  
  .jp-Collab-presence-status-indicator {
    border-width: 3px;
  }
  
  .jp-Collab-cursor-overlay {
    filter: contrast(1.5);
  }
}

/* Reduced motion support */
@media (prefers-reduced-motion: reduce) {
  .jp-Collab-presence-avatar,
  .jp-Collab-presence-connection-dot,
  .jp-Collab-cursor-overlay,
  .jp-Collab-presence-tooltip {
    transition: none;
    animation: none;
  }
  
  .jp-Collab-presence-loading-spinner {
    animation: none;
    border-top-color: var(--jp-border-color2);
  }
  
  .jp-Collab-presence-typing-indicator {
    display: none;
  }
}

/* Focus management for accessibility */
.jp-Collab-presence-avatar:focus-visible {
  outline: 2px solid var(--jp-brand-color1);
  outline-offset: 2px;
}

/* Print styles */
@media print {
  .jp-Collab-presence,
  .jp-Collab-cursor-overlay,
  .jp-Collab-presence-tooltip {
    display: none !important;
  }
}
`;