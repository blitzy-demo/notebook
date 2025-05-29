import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator } from '@jupyterlab/translation';
import React, { useEffect, useState, useCallback } from 'react';

/**
 * Interface for cursor position in notebook context
 */
export interface ICursorPosition {
  cellId: string;
  line: number;
  column: number;
  cellType?: 'code' | 'markdown' | 'raw';
}

/**
 * Interface for selection range in notebook context
 */
export interface ISelectionRange {
  start: ICursorPosition;
  end: ICursorPosition;
}

/**
 * Interface for user information
 */
export interface ICollaborativeUser {
  name: string;
  color: string;
  avatar?: string;
  clientId: number;
  email?: string;
}

/**
 * Interface for awareness state data following Yjs protocol
 */
export interface IAwarenessState {
  user?: ICollaborativeUser;
  cursor?: ICursorPosition;
  selection?: ISelectionRange;
  viewport?: {
    cellId: string;
    scrollTop: number;
    visibleCells: string[];
  };
  lastActivity?: number;
  status?: 'active' | 'idle' | 'offline' | 'typing';
  currentCell?: string;
}

/**
 * Interface for YjsNotebookProvider (placeholder - will be provided by the collaboration module)
 */
export interface IYjsNotebookProvider {
  awareness: {
    getStates(): Map<number, IAwarenessState>;
    setLocalState(state: IAwarenessState | null): void;
    setLocalStateField(field: string, value: any): void;
    getLocalState(): IAwarenessState | null;
    clientID: number;
    on(event: 'change' | 'update', handler: (changes: {
      added: number[];
      updated: number[];
      removed: number[];
    }) => void): void;
    off(event: 'change' | 'update', handler: (changes: {
      added: number[];
      updated: number[];
      removed: number[];
    }) => void): void;
  };
  isConnected: boolean;
}

/**
 * Props for the UserPresence component
 */
export interface IUserPresenceProps {
  provider: IYjsNotebookProvider;
  translator: ITranslator;
  currentUser?: {
    name: string;
    color?: string;
    avatar?: string;
  };
}

/**
 * Generate a deterministic color for a user based on their name or clientId
 */
const generateUserColor = (identifier: string | number): string => {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
    '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
    '#F8C471', '#82E0AA', '#F1948A', '#85C1E9', '#D2B4DE'
  ];
  
  const hash = typeof identifier === 'string' 
    ? identifier.split('').reduce((a, b) => {
        a = ((a << 5) - a) + b.charCodeAt(0);
        return a & a;
      }, 0)
    : identifier;
  
  return colors[Math.abs(hash) % colors.length];
};

/**
 * Generate user initials from a name
 */
const getUserInitials = (name: string): string => {
  return name
    .split(' ')
    .map(part => part.charAt(0).toUpperCase())
    .slice(0, 2)
    .join('');
};

/**
 * Format last activity time as a human-readable string
 */
const formatLastActivity = (timestamp: number, translator: ITranslator): string => {
  const trans = translator.load('notebook');
  const now = Date.now();
  const diff = now - timestamp;
  
  if (diff < 60000) { // Less than 1 minute
    return trans.__('Just now');
  } else if (diff < 3600000) { // Less than 1 hour
    const minutes = Math.floor(diff / 60000);
    return trans.__('%1 minute(s) ago', minutes);
  } else if (diff < 86400000) { // Less than 1 day
    const hours = Math.floor(diff / 3600000);
    return trans.__('%1 hour(s) ago', hours);
  } else {
    const days = Math.floor(diff / 86400000);
    return trans.__('%1 day(s) ago', days);
  }
};

/**
 * Individual user avatar component with enhanced presence information
 */
const UserAvatar: React.FC<{
  user: ICollaborativeUser;
  status: IAwarenessState['status'];
  cursor?: ICursorPosition;
  currentCell?: string;
  lastActivity?: number;
  translator: ITranslator;
  isCurrentUser?: boolean;
  onClick?: () => void;
}> = ({ user, status, cursor, currentCell, lastActivity, translator, isCurrentUser, onClick }) => {
  const trans = translator.load('notebook');
  
  if (!user) return null;
  
  const userColor = user.color || generateUserColor(user.name);
  const initials = getUserInitials(user.name);
  const activityText = lastActivity ? formatLastActivity(lastActivity, translator) : '';
  
  const statusInfo = {
    'active': { icon: '🟢', label: trans.__('Active') },
    'idle': { icon: '🟡', label: trans.__('Idle') },
    'offline': { icon: '⚪', label: trans.__('Offline') },
    'typing': { icon: '⌨️', label: trans.__('Typing') }
  }[status || 'offline'];
  
  // Enhanced tooltip with cursor and cell information
  const buildTooltip = (): string => {
    let tooltip = `${user.name} - ${statusInfo.label}`;
    
    if (user.email) {
      tooltip += ` (${user.email})`;
    }
    
    if (cursor && currentCell) {
      tooltip += `\n${trans.__('Editing cell')}: ${currentCell}`;
      if (cursor.line !== undefined && cursor.column !== undefined) {
        tooltip += `\n${trans.__('Position')}: ${trans.__('Line %1, Column %2', cursor.line + 1, cursor.column + 1)}`;
      }
    } else if (currentCell) {
      tooltip += `\n${trans.__('Viewing cell')}: ${currentCell}`;
    }
    
    if (activityText) {
      tooltip += `\n${trans.__('Last seen')}: ${activityText}`;
    }
    
    return tooltip;
  };
  
  return (
    <div 
      className={`jp-Collab-UserAvatar ${isCurrentUser ? 'jp-Collab-UserAvatar-current' : ''} ${status === 'typing' ? 'jp-Collab-UserAvatar-typing' : ''}`}
      title={buildTooltip()}
      onClick={onClick}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '32px',
        height: '32px',
        borderRadius: '50%',
        backgroundColor: userColor,
        color: 'white',
        fontSize: '12px',
        fontWeight: 'bold',
        margin: '0 4px',
        cursor: onClick ? 'pointer' : 'default',
        border: isCurrentUser ? '2px solid #0066cc' : '2px solid transparent',
        transition: 'all 0.2s ease',
        animation: status === 'typing' ? 'jp-Collab-pulse 1.5s infinite' : 'none'
      }}
    >
      {user.avatar ? (
        <img 
          src={user.avatar} 
          alt={user.name}
          style={{
            width: '100%',
            height: '100%',
            borderRadius: '50%',
            objectFit: 'cover'
          }}
        />
      ) : (
        <span>{initials}</span>
      )}
      
      {/* Status indicator */}
      <div 
        style={{
          position: 'absolute',
          bottom: '-2px',
          right: '-2px',
          fontSize: '10px',
          lineHeight: '1',
          backgroundColor: 'white',
          borderRadius: '50%',
          padding: '1px',
          border: '1px solid #ccc'
        }}
      >
        {statusInfo.icon}
      </div>
      
      {/* Typing indicator */}
      {status === 'typing' && (
        <div 
          style={{
            position: 'absolute',
            top: '-4px',
            left: '-4px',
            fontSize: '8px',
            backgroundColor: userColor,
            borderRadius: '50%',
            padding: '2px',
            animation: 'jp-Collab-bounce 0.8s infinite'
          }}
        >
          ⌨️
        </div>
      )}
    </div>
  );
};

/**
 * Cursor overlay component for rendering remote cursors in the notebook
 */
const CursorOverlay: React.FC<{
  users: Map<number, IAwarenessState>;
  currentUserClientId: number;
  translator: ITranslator;
}> = ({ users, currentUserClientId, translator }) => {
  // This component would render cursor positions overlays
  // For notebook context, we'll focus on cell-level indicators rather than character-level cursors
  // as notebooks are more structured than plain text editors
  
  const activeCursors = Array.from(users.entries())
    .filter(([clientId, state]) => 
      clientId !== currentUserClientId && 
      state.cursor && 
      state.user && 
      state.status === 'active'
    );
  
  if (activeCursors.length === 0) return null;
  
  return (
    <div className="jp-Collab-CursorOverlay">
      {activeCursors.map(([clientId, state]) => {
        const { cursor, user } = state;
        if (!cursor || !user) return null;
        
        return (
          <div
            key={clientId}
            className="jp-Collab-RemoteCursor"
            data-cell-id={cursor.cellId}
            style={{
              position: 'absolute',
              pointerEvents: 'none',
              zIndex: 1000,
              // Position would be calculated based on cell location
              // This is a simplified representation
            }}
          >
            <div
              className="jp-Collab-CursorFlag"
              style={{
                backgroundColor: user.color,
                color: 'white',
                padding: '2px 6px',
                borderRadius: '4px',
                fontSize: '11px',
                fontWeight: 'bold',
                whiteSpace: 'nowrap',
                marginBottom: '2px'
              }}
            >
              {user.name}
            </div>
            <div
              className="jp-Collab-CursorLine"
              style={{
                width: '2px',
                height: '20px',
                backgroundColor: user.color,
                marginLeft: '8px'
              }}
            />
          </div>
        );
      })}
    </div>
  );
};

/**
 * React component for displaying user presence information with enhanced collaboration features
 */
const UserPresenceComponent: React.FC<IUserPresenceProps> = ({
  provider,
  translator,
  currentUser
}) => {
  const trans = translator.load('notebook');
  const [users, setUsers] = useState<Map<number, IAwarenessState>>(new Map());
  const [isConnected, setIsConnected] = useState(provider.isConnected);
  const [expandedView, setExpandedView] = useState(false);
  const [lastUpdateTime, setLastUpdateTime] = useState<number>(Date.now());
  
  // Update users when awareness changes
  const handleAwarenessChange = useCallback((changes?: {
    added: number[];
    updated: number[];
    removed: number[];
  }) => {
    const states = provider.awareness.getStates();
    setUsers(new Map(states));
    setLastUpdateTime(Date.now());
    
    // Log awareness changes for debugging
    if (changes) {
      console.debug('Awareness change:', {
        added: changes.added.length,
        updated: changes.updated.length,
        removed: changes.removed.length,
        totalUsers: states.size
      });
    }
  }, [provider.awareness]);
  
  // Set up current user presence when component mounts
  useEffect(() => {
    if (currentUser && provider.awareness) {
      const userState: IAwarenessState = {
        user: {
          name: currentUser.name,
          color: currentUser.color || generateUserColor(currentUser.name),
          avatar: currentUser.avatar,
          clientId: provider.awareness.clientID,
          email: currentUser.name.includes('@') ? currentUser.name : undefined
        },
        lastActivity: Date.now(),
        status: 'active',
        viewport: {
          cellId: 'notebook-start',
          scrollTop: 0,
          visibleCells: []
        }
      };
      
      provider.awareness.setLocalState(userState);
      
      // Update activity periodically to maintain presence
      const activityInterval = setInterval(() => {
        if (provider.awareness && provider.isConnected) {
          provider.awareness.setLocalStateField('lastActivity', Date.now());
          
          // Update status based on activity
          const lastActivity = document.hasFocus() ? Date.now() : Date.now() - 60000;
          const status = document.hasFocus() ? 'active' : 'idle';
          provider.awareness.setLocalStateField('status', status);
        }
      }, 30000); // Update every 30 seconds
      
      // Handle page focus/blur for status updates
      const handleFocus = () => {
        provider.awareness.setLocalStateField('status', 'active');
        provider.awareness.setLocalStateField('lastActivity', Date.now());
      };
      
      const handleBlur = () => {
        provider.awareness.setLocalStateField('status', 'idle');
      };
      
      window.addEventListener('focus', handleFocus);
      window.addEventListener('blur', handleBlur);
      
      return () => {
        clearInterval(activityInterval);
        window.removeEventListener('focus', handleFocus);
        window.removeEventListener('blur', handleBlur);
        
        // Clean up presence on unmount
        provider.awareness.setLocalState(null);
      };
    }
  }, [currentUser, provider.awareness, provider.isConnected]);
  
  // Subscribe to awareness changes
  useEffect(() => {
    provider.awareness.on('change', handleAwarenessChange);
    provider.awareness.on('update', handleAwarenessChange);
    
    // Initial load
    handleAwarenessChange();
    
    return () => {
      provider.awareness.off('change', handleAwarenessChange);
      provider.awareness.off('update', handleAwarenessChange);
    };
  }, [provider.awareness, handleAwarenessChange]);
  
  // Monitor connection status
  useEffect(() => {
    setIsConnected(provider.isConnected);
    
    // This would typically be connected to provider connection events
    // For now, we'll check periodically and handle reconnection
    const connectionCheck = setInterval(() => {
      const wasConnected = isConnected;
      const nowConnected = provider.isConnected;
      
      if (!wasConnected && nowConnected) {
        // Reconnected - re-establish presence
        if (currentUser) {
          const userState: IAwarenessState = {
            user: {
              name: currentUser.name,
              color: currentUser.color || generateUserColor(currentUser.name),
              avatar: currentUser.avatar,
              clientId: provider.awareness.clientID
            },
            lastActivity: Date.now(),
            status: 'active'
          };
          provider.awareness.setLocalState(userState);
        }
      }
      
      setIsConnected(nowConnected);
    }, 5000);
    
    return () => clearInterval(connectionCheck);
  }, [provider.isConnected, isConnected, currentUser, provider.awareness]);
  
  // Filter and sort users
  const otherUsers = Array.from(users.entries())
    .filter(([clientId, state]) => 
      clientId !== provider.awareness.clientID && 
      state.user && 
      state.status !== 'offline'
    )
    .sort(([, a], [, b]) => {
      // Sort by status (active first), then by name
      if (a.status !== b.status) {
        const statusOrder = { 'typing': 0, 'active': 1, 'idle': 2, 'offline': 3 };
        return (statusOrder[a.status || 'offline'] || 3) - (statusOrder[b.status || 'offline'] || 3);
      }
      return (a.user?.name || '').localeCompare(b.user?.name || '');
    })
    .map(([clientId, state]) => ({ clientId, ...state }));
  
  const currentUserState = users.get(provider.awareness.clientID);
  
  // Handle user avatar click - could navigate to their current location
  const handleUserClick = useCallback((user: { clientId: number } & IAwarenessState) => {
    if (user.currentCell || user.cursor) {
      console.log('Navigate to user location:', {
        user: user.user?.name,
        cellId: user.currentCell || user.cursor?.cellId,
        cursor: user.cursor
      });
      // This would trigger navigation to the user's current cell
      // Implementation would depend on the notebook panel integration
    }
  }, []);
  
  // Responsive behavior - collapse to compact view on smaller screens
  const isCompactView = !expandedView && otherUsers.length > 3;
  const displayedUsers = isCompactView ? otherUsers.slice(0, 3) : otherUsers;
  const hiddenUserCount = isCompactView ? otherUsers.length - 3 : 0;
  
  return (
    <div className="jp-Collab-UserPresence" style={{ 
      display: 'flex', 
      alignItems: 'center', 
      padding: '4px 8px',
      backgroundColor: 'var(--jp-layout-color0)',
      borderRadius: '4px',
      border: '1px solid var(--jp-border-color1)'
    }}>
      {/* Connection status indicator */}
      <div 
        className={`jp-Collab-ConnectionStatus ${isConnected ? 'connected' : 'disconnected'}`}
        title={isConnected ? 
          trans.__('Connected to collaboration server\nLast update: %1', new Date(lastUpdateTime).toLocaleTimeString()) : 
          trans.__('Disconnected from collaboration server')
        }
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          marginRight: '8px',
          fontSize: '11px',
          fontWeight: '500',
          color: isConnected ? '#28a745' : '#dc3545',
          cursor: 'help'
        }}
      >
        <span style={{ marginRight: '4px', fontSize: '12px' }}>
          {isConnected ? '🔗' : '⚠️'}
        </span>
        <span className="jp-Collab-ConnectionLabel">
          {isConnected ? trans.__('Live') : trans.__('Offline')}
        </span>
      </div>
      
      {/* Current user avatar */}
      {currentUserState?.user && (
        <UserAvatar
          user={currentUserState.user}
          status={currentUserState.status}
          cursor={currentUserState.cursor}
          currentCell={currentUserState.currentCell}
          lastActivity={currentUserState.lastActivity}
          translator={translator}
          isCurrentUser={true}
        />
      )}
      
      {/* Separator between current user and others */}
      {currentUserState?.user && otherUsers.length > 0 && (
        <div style={{
          width: '1px',
          height: '20px',
          backgroundColor: 'var(--jp-border-color2)',
          margin: '0 8px'
        }} />
      )}
      
      {/* Other users list */}
      <div className="jp-Collab-OtherUsers" style={{ display: 'inline-flex', alignItems: 'center' }}>
        {displayedUsers.map(({ clientId, user, status, cursor, currentCell, lastActivity }) => (
          <UserAvatar
            key={clientId}
            user={user!}
            status={status}
            cursor={cursor}
            currentCell={currentCell}
            lastActivity={lastActivity}
            translator={translator}
            isCurrentUser={false}
            onClick={() => handleUserClick({ clientId, user, status, cursor, currentCell, lastActivity })}
          />
        ))}
        
        {/* Show more users button */}
        {hiddenUserCount > 0 && (
          <button
            className="jp-Collab-MoreUsers"
            onClick={() => setExpandedView(!expandedView)}
            title={trans.__('Show %1 more user(s)', hiddenUserCount)}
            style={{
              background: 'var(--jp-layout-color2)',
              border: '1px solid var(--jp-border-color1)',
              borderRadius: '50%',
              width: '32px',
              height: '32px',
              fontSize: '12px',
              fontWeight: 'bold',
              margin: '0 4px',
              cursor: 'pointer',
              color: 'var(--jp-ui-font-color1)'
            }}
          >
            +{hiddenUserCount}
          </button>
        )}
      </div>
      
      {/* User count and status summary */}
      {otherUsers.length > 0 && (
        <div 
          className="jp-Collab-StatusSummary"
          style={{
            marginLeft: '8px',
            fontSize: '11px',
            color: 'var(--jp-ui-font-color2)',
            fontWeight: 'normal'
          }}
        >
          {otherUsers.length === 1 ? 
            trans.__('1 other user') : 
            trans.__('%1 other users', otherUsers.length)
          }
          {otherUsers.filter(u => u.status === 'typing').length > 0 && (
            <span style={{ color: '#007acc', marginLeft: '4px' }}>
              ({otherUsers.filter(u => u.status === 'typing').length} {trans.__('typing')})
            </span>
          )}
        </div>
      )}
      
      {/* No other users message */}
      {otherUsers.length === 0 && isConnected && (
        <div 
          className="jp-Collab-NoOthers"
          style={{
            marginLeft: '8px',
            fontSize: '11px',
            color: 'var(--jp-ui-font-color2)',
            fontStyle: 'italic'
          }}
        >
          {trans.__('Working solo')}
        </div>
      )}
      
      {/* Render cursor overlays */}
      <CursorOverlay 
        users={users} 
        currentUserClientId={provider.awareness.clientID} 
        translator={translator} 
      />
    </div>
  );
};

/**
 * CSS styles for UserPresence animations and theming
 */
const PRESENCE_STYLES = `
  @keyframes jp-Collab-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.7; transform: scale(1.05); }
  }
  
  @keyframes jp-Collab-bounce {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-2px); }
  }
  
  .jp-Collab-UserPresence {
    font-family: var(--jp-ui-font-family);
    font-size: var(--jp-ui-font-size1);
  }
  
  .jp-Collab-UserAvatar:hover {
    transform: scale(1.1);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  }
  
  .jp-Collab-UserAvatar-typing {
    border-color: #007acc !important;
    box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.3);
  }
  
  .jp-Collab-ConnectionStatus.connected .jp-Collab-ConnectionLabel {
    color: var(--jp-success-color1);
  }
  
  .jp-Collab-ConnectionStatus.disconnected .jp-Collab-ConnectionLabel {
    color: var(--jp-error-color1);
  }
  
  .jp-Collab-MoreUsers:hover {
    background: var(--jp-layout-color3) !important;
    transform: scale(1.05);
  }
  
  @media (max-width: 768px) {
    .jp-Collab-UserPresence {
      font-size: var(--jp-ui-font-size0);
    }
    
    .jp-Collab-UserAvatar {
      width: 28px !important;
      height: 28px !important;
      font-size: 10px !important;
      margin: 0 2px !important;
    }
    
    .jp-Collab-ConnectionLabel {
      display: none;
    }
    
    .jp-Collab-StatusSummary {
      display: none;
    }
  }
`;

/**
 * Inject CSS styles for UserPresence component
 */
const injectPresenceStyles = (): void => {
  const styleId = 'jp-collab-user-presence-styles';
  
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = PRESENCE_STYLES;
    document.head.appendChild(style);
  }
};

/**
 * Namespace for UserPresence component utilities and integrations
 */
export namespace UserPresence {
  /**
   * User presence configuration options
   */
  export interface IPresenceOptions {
    provider: IYjsNotebookProvider;
    translator: ITranslator;
    currentUser?: {
      name: string;
      color?: string;
      avatar?: string;
    };
    showCursors?: boolean;
    showStatus?: boolean;
    compact?: boolean;
    maxDisplayedUsers?: number;
  }
  
  /**
   * Create a new UserPresence widget with enhanced configuration
   * 
   * @param options - Configuration options for the user presence widget
   */
  export const create = (options: IPresenceOptions): ReactWidget => {
    // Inject CSS styles when creating the widget
    injectPresenceStyles();
    
    const widget = ReactWidget.create(
      <UserPresenceComponent {...options} />
    );
    
    // Add CSS classes for theming
    widget.addClass('jp-Collab-UserPresenceWidget');
    widget.node.setAttribute('data-jp-theme-schematic', 'true');
    
    return widget;
  };
  
  /**
   * Update user cursor position in awareness
   * 
   * @param provider - The Yjs notebook provider
   * @param cursor - Cursor position information
   */
  export const updateCursor = (
    provider: IYjsNotebookProvider,
    cursor: ICursorPosition
  ): void => {
    if (provider.awareness) {
      provider.awareness.setLocalStateField('cursor', cursor);
      provider.awareness.setLocalStateField('lastActivity', Date.now());
      provider.awareness.setLocalStateField('status', 'active');
    }
  };
  
  /**
   * Update user selection in awareness
   * 
   * @param provider - The Yjs notebook provider
   * @param selection - Selection range information
   */
  export const updateSelection = (
    provider: IYjsNotebookProvider,
    selection: ISelectionRange | null
  ): void => {
    if (provider.awareness) {
      provider.awareness.setLocalStateField('selection', selection);
      provider.awareness.setLocalStateField('lastActivity', Date.now());
    }
  };
  
  /**
   * Update user viewport information
   * 
   * @param provider - The Yjs notebook provider
   * @param viewport - Viewport information
   */
  export const updateViewport = (
    provider: IYjsNotebookProvider,
    viewport: IAwarenessState['viewport']
  ): void => {
    if (provider.awareness) {
      provider.awareness.setLocalStateField('viewport', viewport);
      provider.awareness.setLocalStateField('lastActivity', Date.now());
    }
  };
  
  /**
   * Set user typing status
   * 
   * @param provider - The Yjs notebook provider
   * @param isTyping - Whether the user is currently typing
   * @param cellId - The cell being edited (optional)
   */
  export const setTypingStatus = (
    provider: IYjsNotebookProvider,
    isTyping: boolean,
    cellId?: string
  ): void => {
    if (provider.awareness) {
      provider.awareness.setLocalStateField('status', isTyping ? 'typing' : 'active');
      if (cellId) {
        provider.awareness.setLocalStateField('currentCell', cellId);
      }
      provider.awareness.setLocalStateField('lastActivity', Date.now());
    }
  };
  
  /**
   * Get all active users from awareness
   * 
   * @param provider - The Yjs notebook provider
   * @returns Array of active users with their state
   */
  export const getActiveUsers = (
    provider: IYjsNotebookProvider
  ): Array<{ clientId: number; state: IAwarenessState }> => {
    if (!provider.awareness) return [];
    
    return Array.from(provider.awareness.getStates().entries())
      .filter(([, state]) => state.user && state.status !== 'offline')
      .map(([clientId, state]) => ({ clientId, state }));
  };
  
  /**
   * Navigate to a user's current location
   * 
   * @param provider - The Yjs notebook provider
   * @param clientId - The client ID of the user to follow
   * @returns Promise that resolves when navigation is complete
   */
  export const followUser = async (
    provider: IYjsNotebookProvider,
    clientId: number
  ): Promise<void> => {
    const userState = provider.awareness.getStates().get(clientId);
    if (userState?.cursor?.cellId || userState?.currentCell) {
      const targetCellId = userState.cursor?.cellId || userState.currentCell;
      console.log(`Following user to cell: ${targetCellId}`);
      
      // This would integrate with the notebook panel to scroll to the cell
      // Implementation depends on the notebook widget integration
      const cellElement = document.querySelector(`[data-cell-id="${targetCellId}"]`);
      if (cellElement) {
        cellElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  };
  
  /**
   * Cleanup presence when leaving a notebook
   * 
   * @param provider - The Yjs notebook provider
   */
  export const cleanup = (provider: IYjsNotebookProvider): void => {
    if (provider.awareness) {
      provider.awareness.setLocalState(null);
    }
  };
}