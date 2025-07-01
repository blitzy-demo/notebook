import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator } from '@jupyterlab/translation';
import { Notebook } from '@jupyterlab/notebook';
import { IYjsNotebookProvider } from '@jupyter-notebook/notebook/lib/collab/provider';
import { IPresenceTracker, IAwarenessRegistry, IUserColorManager, UserPresenceState, ConnectionStatus } from '@jupyter-notebook/notebook/lib/collab/awareness';
import React, { useEffect, useState, useCallback, useMemo } from 'react';

/**
 * Interface for user presence information
 */
export interface IUserPresence {
  /**
   * Unique user identifier
   */
  userId: string;
  
  /**
   * Display name of the user
   */
  displayName: string;
  
  /**
   * User avatar URL or initials
   */
  avatar?: string;
  
  /**
   * User's assigned color for presence indicators
   */
  color: string;
  
  /**
   * Current connection status
   */
  connectionStatus: ConnectionStatus;
  
  /**
   * Current cursor position in the notebook
   */
  cursorPosition?: {
    cellId: string;
    offset: number;
    selectionStart?: number;
    selectionEnd?: number;
  };
  
  /**
   * Last activity timestamp
   */
  lastActivity: number;
  
  /**
   * Currently editing cell ID
   */
  activeCell?: string;
}

/**
 * Props for the UserPresenceComponent
 */
export interface IUserPresenceProps {
  /**
   * The notebook instance
   */
  notebook: Notebook;
  
  /**
   * Yjs collaboration provider
   */
  collaborationProvider: IYjsNotebookProvider;
  
  /**
   * Translation service
   */
  translator: ITranslator;
  
  /**
   * Maximum number of avatars to display before showing overflow
   */
  maxVisibleAvatars?: number;
  
  /**
   * Whether to show detailed presence information on hover
   */
  showDetailedInfo?: boolean;
  
  /**
   * Callback when user clicks on a presence indicator
   */
  onPresenceClick?: (userId: string) => void;
}

/**
 * Individual user avatar component with presence indicators
 */
const UserAvatar: React.FC<{
  user: IUserPresence;
  translator: ITranslator;
  showDetailedInfo: boolean;
  onClick?: () => void;
}> = ({ user, translator, showDetailedInfo, onClick }) => {
  const trans = translator.load('notebook-collaboration');
  
  const avatarStyle: React.CSSProperties = {
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    border: `2px solid ${user.color}`,
    backgroundColor: user.avatar ? 'transparent' : user.color,
    color: user.avatar ? 'transparent' : '#ffffff',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 4px',
    cursor: onClick ? 'pointer' : 'default',
    position: 'relative',
    fontSize: '12px',
    fontWeight: 'bold',
    opacity: user.connectionStatus === 'connected' ? 1 : 0.6,
    transition: 'opacity 0.2s ease'
  };
  
  const statusIndicatorStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: '-2px',
    right: '-2px',
    width: '12px',
    height: '12px',
    borderRadius: '50%',
    border: '2px solid white',
    backgroundColor: user.connectionStatus === 'connected' ? '#00ff00' : 
                    user.connectionStatus === 'disconnected' ? '#ffff00' : '#ff0000'
  };
  
  const getInitials = (name: string): string => {
    return name.split(' ')
      .map(word => word.charAt(0))
      .join('')
      .substring(0, 2)
      .toUpperCase();
  };
  
  const getStatusText = (status: ConnectionStatus): string => {
    switch (status) {
      case 'connected':
        return trans.__('Connected');
      case 'disconnected':
        return trans.__('Disconnected');
      case 'offline':
        return trans.__('Offline');
      default:
        return trans.__('Unknown');
    }
  };
  
  const getTooltipContent = (): string => {
    if (!showDetailedInfo) {
      return `${user.displayName} (${getStatusText(user.connectionStatus)})`;
    }
    
    const lastActivityTime = new Date(user.lastActivity).toLocaleTimeString();
    let tooltip = `${user.displayName}\n${getStatusText(user.connectionStatus)}\n${trans.__('Last activity')}: ${lastActivityTime}`;
    
    if (user.activeCell) {
      tooltip += `\n${trans.__('Editing cell')}: ${user.activeCell}`;
    }
    
    return tooltip;
  };
  
  return (
    <div
      style={avatarStyle}
      title={getTooltipContent()}
      onClick={onClick}
      role={onClick ? 'button' : 'img'}
      tabIndex={onClick ? 0 : -1}
      onKeyDown={(e) => {
        if (onClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {user.avatar ? (
        <img
          src={user.avatar}
          alt={user.displayName}
          style={{
            width: '100%',
            height: '100%',
            borderRadius: '50%',
            objectFit: 'cover'
          }}
        />
      ) : (
        getInitials(user.displayName)
      )}
      <div style={statusIndicatorStyle} />
    </div>
  );
};

/**
 * Overflow indicator for additional users
 */
const OverflowIndicator: React.FC<{
  count: number;
  translator: ITranslator;
  users: IUserPresence[];
  onClick?: () => void;
}> = ({ count, translator, users, onClick }) => {
  const trans = translator.load('notebook-collaboration');
  
  const overflowStyle: React.CSSProperties = {
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    border: '2px solid #888',
    backgroundColor: '#f0f0f0',
    color: '#333',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 4px',
    cursor: onClick ? 'pointer' : 'default',
    fontSize: '12px',
    fontWeight: 'bold'
  };
  
  const tooltipContent = users
    .map(user => `${user.displayName} (${user.connectionStatus})`)
    .join('\n');
  
  return (
    <div
      style={overflowStyle}
      title={`${trans.__('Additional collaborators')}:\n${tooltipContent}`}
      onClick={onClick}
      role={onClick ? 'button' : 'img'}
      tabIndex={onClick ? 0 : -1}
      onKeyDown={(e) => {
        if (onClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      +{count}
    </div>
  );
};

/**
 * Main user presence component displaying active collaborators
 */
const UserPresenceComponent: React.FC<IUserPresenceProps> = ({
  notebook,
  collaborationProvider,
  translator,
  maxVisibleAvatars = 5,
  showDetailedInfo = true,
  onPresenceClick
}) => {
  const trans = translator.load('notebook-collaboration');
  const [activeUsers, setActiveUsers] = useState<IUserPresence[]>([]);
  const [showOverflow, setShowOverflow] = useState(false);
  
  /**
   * Update presence information from the collaboration provider
   */
  const updatePresence = useCallback(async () => {
    try {
      const presenceStates = await collaborationProvider.getAwarenessStates();
      const userColorManager = collaborationProvider.getUserColorManager();
      
      const users: IUserPresence[] = Array.from(presenceStates.entries())
        .filter(([clientId, state]) => state && state.user)
        .map(([clientId, state]) => ({
          userId: state.user.id || clientId.toString(),
          displayName: state.user.name || `User ${clientId}`,
          avatar: state.user.avatar,
          color: userColorManager.getUserColor(state.user.id || clientId.toString()),
          connectionStatus: state.connectionStatus || 'connected',
          cursorPosition: state.cursor,
          lastActivity: state.lastActivity || Date.now(),
          activeCell: state.activeCell
        }))
        .sort((a, b) => b.lastActivity - a.lastActivity);
      
      setActiveUsers(users);
    } catch (error) {
      console.error('Error updating user presence:', error);
    }
  }, [collaborationProvider]);
  
  /**
   * Handle awareness changes from the collaboration provider
   */
  const handleAwarenessChange = useCallback((states: Map<number, UserPresenceState>) => {
    updatePresence();
  }, [updatePresence]);
  
  /**
   * Handle presence indicator clicks
   */
  const handlePresenceClick = useCallback((userId: string) => {
    if (onPresenceClick) {
      onPresenceClick(userId);
    } else {
      // Default behavior: scroll to user's active cell
      const user = activeUsers.find(u => u.userId === userId);
      if (user && user.activeCell && notebook) {
        const cells = notebook.model?.cells;
        if (cells) {
          const cellIndex = cells.length ? 
            Array.from(cells).findIndex(cell => cell.id === user.activeCell) : -1;
          if (cellIndex >= 0 && notebook.widgets) {
            notebook.activeCellIndex = cellIndex;
            notebook.widgets[cellIndex]?.node.scrollIntoView({ 
              behavior: 'smooth', 
              block: 'center' 
            });
          }
        }
      }
    }
  }, [activeUsers, notebook, onPresenceClick]);
  
  /**
   * Toggle overflow display
   */
  const toggleOverflow = useCallback(() => {
    setShowOverflow(prev => !prev);
  }, []);
  
  // Subscribe to awareness changes
  useEffect(() => {
    if (!collaborationProvider) return;
    
    const awarenessRegistry = collaborationProvider.getAwarenessRegistry();
    if (awarenessRegistry) {
      awarenessRegistry.onAwarenessChange(handleAwarenessChange);
      
      return () => {
        awarenessRegistry.offAwarenessChange(handleAwarenessChange);
      };
    }
  }, [collaborationProvider, handleAwarenessChange]);
  
  // Initial presence update
  useEffect(() => {
    updatePresence();
    
    // Set up periodic updates for connection status
    const intervalId = setInterval(updatePresence, 5000);
    
    return () => {
      clearInterval(intervalId);
    };
  }, [updatePresence]);
  
  // Calculate visible and overflow users
  const { visibleUsers, overflowUsers } = useMemo(() => {
    if (showOverflow || activeUsers.length <= maxVisibleAvatars) {
      return { visibleUsers: activeUsers, overflowUsers: [] };
    }
    
    return {
      visibleUsers: activeUsers.slice(0, maxVisibleAvatars),
      overflowUsers: activeUsers.slice(maxVisibleAvatars)
    };
  }, [activeUsers, maxVisibleAvatars, showOverflow]);
  
  const containerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    padding: '4px 8px',
    backgroundColor: '#f8f9fa',
    borderRadius: '20px',
    border: '1px solid #e9ecef',
    minHeight: '40px',
    fontFamily: 'var(--jp-ui-font-family)'
  };
  
  const labelStyle: React.CSSProperties = {
    fontSize: '12px',
    color: '#6c757d',
    marginRight: '8px',
    fontWeight: '500'
  };
  
  if (activeUsers.length === 0) {
    return (
      <div style={containerStyle}>
        <span style={{ ...labelStyle, color: '#adb5bd' }}>
          {trans.__('No active collaborators')}
        </span>
      </div>
    );
  }
  
  return (
    <div style={containerStyle}>
      <span style={labelStyle}>
        {trans._n('%1 collaborator', '%1 collaborators', activeUsers.length)}
      </span>
      
      {visibleUsers.map(user => (
        <UserAvatar
          key={user.userId}
          user={user}
          translator={translator}
          showDetailedInfo={showDetailedInfo}
          onClick={() => handlePresenceClick(user.userId)}
        />
      ))}
      
      {overflowUsers.length > 0 && !showOverflow && (
        <OverflowIndicator
          count={overflowUsers.length}
          translator={translator}
          users={overflowUsers}
          onClick={toggleOverflow}
        />
      )}
      
      {showOverflow && overflowUsers.length > 0 && (
        <>
          {overflowUsers.map(user => (
            <UserAvatar
              key={user.userId}
              user={user}
              translator={translator}
              showDetailedInfo={showDetailedInfo}
              onClick={() => handlePresenceClick(user.userId)}
            />
          ))}
          <div
            style={{
              cursor: 'pointer',
              marginLeft: '8px',
              fontSize: '12px',
              color: '#6c757d'
            }}
            onClick={toggleOverflow}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleOverflow();
              }
            }}
          >
            {trans.__('Show less')}
          </div>
        </>
      )}
    </div>
  );
};

/**
 * A namespace for UserPresenceWidget static methods.
 */
export namespace UserPresenceWidget {
  /**
   * Options for creating a UserPresenceWidget
   */
  export interface IOptions {
    /**
     * The notebook instance
     */
    notebook: Notebook;
    
    /**
     * Yjs collaboration provider
     */
    collaborationProvider: IYjsNotebookProvider;
    
    /**
     * Translation service
     */
    translator: ITranslator;
    
    /**
     * Configuration options
     */
    config?: {
      maxVisibleAvatars?: number;
      showDetailedInfo?: boolean;
      onPresenceClick?: (userId: string) => void;
    };
  }
  
  /**
   * Create a new UserPresenceWidget
   *
   * @param options - The options for creating the widget
   * @returns A new ReactWidget containing the user presence component
   */
  export const create = (options: IOptions): ReactWidget => {
    const { notebook, collaborationProvider, translator, config = {} } = options;
    
    return ReactWidget.create(
      <UserPresenceComponent
        notebook={notebook}
        collaborationProvider={collaborationProvider}
        translator={translator}
        maxVisibleAvatars={config.maxVisibleAvatars}
        showDetailedInfo={config.showDetailedInfo}
        onPresenceClick={config.onPresenceClick}
      />
    );
  };
}

/**
 * Default export for the UserPresenceComponent
 */
export { UserPresenceComponent };