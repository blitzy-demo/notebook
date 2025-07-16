// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import * as React from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { CommandRegistry } from '@lumino/commands';
import { ITranslator } from '@jupyterlab/translation';
import { Menu } from '@lumino/widgets';
import { Time } from '@jupyterlab/coreutils';
import UserAwareness, { IUser, ConnectionStatus } from '../../../notebook/src/collab/awareness';
import YjsNotebookProvider from '../../../notebook/src/collab/provider';

/**
 * Interface for connection status information
 */
export interface IConnectionStatus {
  /** Current connection status */
  status: string;
  /** Unique session identifier */
  sessionId: string;
  /** Timestamp when connection was established */
  connectedAt: number;
  /** Timestamp of last successful synchronization */
  lastSyncAt: number;
  /** Whether the connection is currently attempting to reconnect */
  isReconnecting: boolean;
  /** Connection quality indicator (0-100) */
  connectionQuality: number;
}

/**
 * Interface for collaborator information
 */
export interface ICollaboratorInfo {
  /** Unique user identifier */
  userId: string;
  /** Username for display */
  username: string;
  /** Display name */
  displayName: string;
  /** User avatar URL or data */
  avatar?: string;
  /** User color for presence indicators */
  color: string;
  /** Whether user is currently online */
  isOnline: boolean;
  /** Timestamp of last activity */
  lastActive: number;
  /** Current cell being worked on */
  currentCell?: string;
  /** Current activity status */
  activityStatus: string;
}

/**
 * Interface for status bar configuration
 */
export interface IStatusBarConfig {
  /** Whether to show user count */
  showUserCount: boolean;
  /** Whether to show connection status */
  showConnectionStatus: boolean;
  /** Whether to show session ID */
  showSessionId: boolean;
  /** Maximum number of users to display individually */
  maxDisplayedUsers: number;
  /** Enable compact mode for smaller screens */
  compactMode: boolean;
  /** Whether to show options menu */
  showOptionsMenu: boolean;
}

/**
 * Interface for collaboration status bar props
 */
export interface ICollaborationStatusBarProps {
  /** User awareness instance for tracking collaborators */
  userAwareness: UserAwareness;
  /** Yjs provider instance for connection management */
  provider: YjsNotebookProvider;
  /** Translation service */
  translator: ITranslator;
  /** Callback for settings click */
  onSettingsClick?: () => void;
  /** Callback for share click */
  onShareClick?: () => void;
  /** Callback for permissions click */
  onPermissionsClick?: () => void;
  /** Optional CSS class name */
  className?: string;
  /** Optional inline styles */
  style?: React.CSSProperties;
}

/**
 * Default configuration for the status bar
 */
const DEFAULT_CONFIG: IStatusBarConfig = {
  showUserCount: true,
  showConnectionStatus: true,
  showSessionId: false,
  maxDisplayedUsers: 5,
  compactMode: false,
  showOptionsMenu: true
};

/**
 * CollaborationStatusBar component that displays collaboration status in the bottom bar
 * of the notebook interface, showing active users, connection state, session information,
 * and providing access to collaboration controls and settings.
 */
export default class CollaborationStatusBar extends React.Component<
  ICollaborationStatusBarProps,
  {
    users: Map<string, IUser>;
    connectionStatus: ConnectionStatus;
    isMenuOpen: boolean;
    config: IStatusBarConfig;
  }
> {
  private _trans: any;
  private _menu: Menu | null = null;
  private _updateTimer: number | null = null;

  constructor(props: ICollaborationStatusBarProps) {
    super(props);
    
    this._trans = props.translator.load('notebook');
    
    this.state = {
      users: new Map(),
      connectionStatus: ConnectionStatus.DISCONNECTED,
      isMenuOpen: false,
      config: DEFAULT_CONFIG
    };
  }

  /**
   * Component lifecycle: Set up event listeners and initialize state
   */
  componentDidMount(): void {
    this._setupEventListeners();
    this._updateState();
    this._startPeriodicUpdate();
    this._addPulseAnimationStyles();
  }

  /**
   * Component lifecycle: Clean up event listeners and timers
   */
  componentWillUnmount(): void {
    this._cleanupEventListeners();
    this._stopPeriodicUpdate();
    if (this._menu) {
      this._menu.dispose();
    }
  }

  /**
   * Set up event listeners for awareness and provider changes
   */
  private _setupEventListeners(): void {
    this.props.userAwareness.onUsersChanged.connect(this._handleUsersChanged);
    this.props.userAwareness.onConnectionStatusChanged.connect(this._handleConnectionStatusChanged);
    this.props.provider.onConnectionStateChanged.connect(this._handleProviderConnectionChanged);
  }

  /**
   * Clean up event listeners
   */
  private _cleanupEventListeners(): void {
    this.props.userAwareness.onUsersChanged.disconnect(this._handleUsersChanged);
    this.props.userAwareness.onConnectionStatusChanged.disconnect(this._handleConnectionStatusChanged);
    this.props.provider.onConnectionStateChanged.disconnect(this._handleProviderConnectionChanged);
  }

  /**
   * Handle users changed event
   */
  private _handleUsersChanged = (sender: any, users: Map<string, IUser>): void => {
    try {
      if (users instanceof Map) {
        this.setState({ users: new Map(users) });
      } else {
        console.warn('Invalid users data received:', users);
      }
    } catch (error) {
      console.error('Error handling users changed event:', error);
    }
  };

  /**
   * Handle connection status changed event
   */
  private _handleConnectionStatusChanged = (sender: any, status: ConnectionStatus): void => {
    try {
      if (Object.values(ConnectionStatus).includes(status)) {
        this.setState({ connectionStatus: status });
      } else {
        console.warn('Invalid connection status received:', status);
      }
    } catch (error) {
      console.error('Error handling connection status changed event:', error);
    }
  };

  /**
   * Handle provider connection changed event
   */
  private _handleProviderConnectionChanged = (sender: any, state: any): void => {
    try {
      if (state && typeof state.connected === 'boolean') {
        this.setState({ 
          connectionStatus: state.connected ? ConnectionStatus.CONNECTED : ConnectionStatus.DISCONNECTED 
        });
      } else {
        console.warn('Invalid provider connection state received:', state);
      }
    } catch (error) {
      console.error('Error handling provider connection changed event:', error);
    }
  };

  /**
   * Update component state from current awareness and provider state
   */
  private _updateState(): void {
    try {
      const users = this.props.userAwareness?.users || new Map();
      const connectionStatus = this.props.userAwareness?.connectionStatus || ConnectionStatus.DISCONNECTED;
      
      this.setState({
        users: new Map(users),
        connectionStatus
      });
    } catch (error) {
      console.error('Error updating collaboration status bar state:', error);
    }
  }

  /**
   * Start periodic update timer
   */
  private _startPeriodicUpdate(): void {
    this._updateTimer = window.setInterval(() => {
      this._updateState();
    }, 5000); // Update every 5 seconds
  }

  /**
   * Stop periodic update timer
   */
  private _stopPeriodicUpdate(): void {
    if (this._updateTimer) {
      clearInterval(this._updateTimer);
      this._updateTimer = null;
    }
  }

  /**
   * Update connection status
   */
  updateConnectionStatus(status: ConnectionStatus): void {
    this.setState({ connectionStatus: status });
  }

  /**
   * Update user count
   */
  updateUserCount(count: number): void {
    // This is handled automatically through the users state
    // but kept for interface compliance
  }

  /**
   * Show options menu
   */
  showOptionsMenu(): void {
    this.setState({ isMenuOpen: true });
  }

  /**
   * Hide options menu
   */
  hideOptionsMenu(): void {
    this.setState({ isMenuOpen: false });
  }

  /**
   * Create options menu
   */
  private _createOptionsMenu(): Menu {
    if (this._menu) {
      this._menu.dispose();
    }

    const commands = new CommandRegistry();
    
    // Register menu commands
    commands.addCommand('collaboration:share', {
      label: this._trans.__('Share Notebook'),
      execute: () => this._handleShareClick()
    });

    commands.addCommand('collaboration:permissions', {
      label: this._trans.__('Manage Permissions'),
      execute: () => this._handlePermissionsClick()
    });

    commands.addCommand('collaboration:history', {
      label: this._trans.__('View History'),
      execute: () => this._showHistoryDialog()
    });

    commands.addCommand('collaboration:reconnect', {
      label: this._trans.__('Reconnect'),
      execute: () => this._handleReconnect(),
      isEnabled: () => this.state.connectionStatus !== ConnectionStatus.CONNECTED
    });

    commands.addCommand('collaboration:session-info', {
      label: this._trans.__('Session Info'),
      execute: () => this._showSessionInfo()
    });

    commands.addCommand('collaboration:settings', {
      label: this._trans.__('Collaboration Settings'),
      execute: () => this._handleSettingsClick()
    });

    this._menu = new Menu({ commands });

    // Add menu items
    this._menu.addItem({ command: 'collaboration:share' });
    this._menu.addItem({ command: 'collaboration:permissions' });
    this._menu.addItem({ command: 'collaboration:history' });
    
    this._menu.addItem({ type: 'separator' });
    
    this._menu.addItem({ command: 'collaboration:reconnect' });
    this._menu.addItem({ command: 'collaboration:session-info' });
    
    this._menu.addItem({ type: 'separator' });
    
    this._menu.addItem({ command: 'collaboration:settings' });

    return this._menu;
  }

  /**
   * Handle options menu click
   */
  private _handleOptionsClick = (event: React.MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();

    try {
      const menu = this._createOptionsMenu();
      menu.open(event.clientX, event.clientY);
    } catch (error) {
      console.error('Failed to open collaboration options menu:', error);
    }
  };

  /**
   * Handle keyboard events for options button
   */
  private _handleOptionsKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this._handleOptionsClick(event as any);
    }
  };

  /**
   * Handle settings click
   */
  private _handleSettingsClick = (): void => {
    if (this.props.onSettingsClick) {
      this.props.onSettingsClick();
    }
  };

  /**
   * Handle share click
   */
  private _handleShareClick = (): void => {
    if (this.props.onShareClick) {
      this.props.onShareClick();
    }
  };

  /**
   * Handle permissions click
   */
  private _handlePermissionsClick = (): void => {
    if (this.props.onPermissionsClick) {
      this.props.onPermissionsClick();
    }
  };

  /**
   * Handle reconnect action
   */
  private _handleReconnect = async (): Promise<void> => {
    try {
      if (this.props.provider && typeof this.props.provider.reconnect === 'function') {
        await this.props.provider.reconnect();
      } else {
        console.warn('Provider reconnect method not available');
      }
    } catch (error) {
      console.error('Failed to reconnect:', error);
    }
  };

  /**
   * Show history dialog
   */
  private _showHistoryDialog = (): void => {
    // This would typically open a dialog showing version history
    console.log('Show history dialog');
  };

  /**
   * Show session information dialog
   */
  private _showSessionInfo = (): void => {
    const sessionInfo = this.props.provider.getSessionInfo ? this.props.provider.getSessionInfo() : null;
    if (sessionInfo) {
      const message = `Session ID: ${sessionInfo.sessionId}\nRoom: ${sessionInfo.roomName}\nConnected Users: ${sessionInfo.connectedUsers}\nUptime: ${Time.formatHuman(new Date(Date.now() - sessionInfo.uptime))}`;
      alert(message); // In a real implementation, this would be a proper dialog
    }
  };

  /**
   * Add pulse animation styles to the document head
   */
  private _addPulseAnimationStyles(): void {
    const existingStyle = document.getElementById('jp-CollaborationStatusBar-styles');
    if (existingStyle) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'jp-CollaborationStatusBar-styles';
    style.textContent = `
      @keyframes jp-CollaborationStatusBar-pulse {
        0% { opacity: 1; }
        50% { opacity: 0.3; }
        100% { opacity: 1; }
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Get connection status icon
   */
  private _getConnectionStatusIcon(): string {
    switch (this.state.connectionStatus) {
      case ConnectionStatus.CONNECTED:
        return 'jp-CircleIcon jp-mod-success';
      case ConnectionStatus.CONNECTING:
      case ConnectionStatus.RECONNECTING:
        return 'jp-CircleIcon jp-mod-warn';
      case ConnectionStatus.DISCONNECTED:
      case ConnectionStatus.ERROR:
        return 'jp-CircleIcon jp-mod-error';
      default:
        return 'jp-CircleIcon';
    }
  }

  /**
   * Get connection status text
   */
  private _getConnectionStatusText(): string {
    switch (this.state.connectionStatus) {
      case ConnectionStatus.CONNECTED:
        return this._trans.__('Connected');
      case ConnectionStatus.CONNECTING:
        return this._trans.__('Connecting...');
      case ConnectionStatus.RECONNECTING:
        return this._trans.__('Reconnecting...');
      case ConnectionStatus.DISCONNECTED:
        return this._trans.__('Disconnected');
      case ConnectionStatus.ERROR:
        return this._trans.__('Connection Error');
      default:
        return this._trans.__('Unknown');
    }
  }

  /**
   * Get active users list
   */
  private _getActiveUsers(): IUser[] {
    return Array.from(this.state.users.values()).filter(user => 
      user.isActive && user.connectionStatus === ConnectionStatus.CONNECTED
    );
  }

  /**
   * Render user avatar
   */
  private _renderUserAvatar(user: IUser, index: number): React.ReactElement {
    const isActive = user.isActive && user.connectionStatus === ConnectionStatus.CONNECTED;
    const lastActiveTime = Time.formatHuman(new Date(user.lastSeen));
    const currentCellInfo = user.currentCell ? ` in cell ${user.currentCell}` : '';
    
    const style: React.CSSProperties = {
      backgroundColor: user.color,
      color: 'white',
      width: '24px',
      height: '24px',
      borderRadius: '50%',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '12px',
      fontWeight: 'bold',
      marginRight: '4px',
      position: 'relative',
      zIndex: 1000 - index,
      opacity: isActive ? 1 : 0.6,
      border: isActive ? '2px solid #4CAF50' : '2px solid transparent',
      boxSizing: 'border-box'
    };

    const avatarContent = user.avatar ? (
      <img 
        src={user.avatar} 
        alt={user.displayName}
        style={{ width: '100%', height: '100%', borderRadius: '50%' }}
      />
    ) : (
      user.displayName.charAt(0).toUpperCase()
    );

    // Activity indicator
    const activityIndicator = isActive ? (
      <div
        style={{
          position: 'absolute',
          bottom: '-2px',
          right: '-2px',
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          backgroundColor: '#4CAF50',
          border: '1px solid white',
          zIndex: 1001
        }}
      />
    ) : null;

    return (
      <div
        key={user.id}
        style={style}
        title={`${user.displayName} (${user.activity})${currentCellInfo}\nLast active: ${lastActiveTime}`}
        className={`jp-CollaborationStatusBar-userAvatar ${isActive ? 'jp-mod-active' : 'jp-mod-inactive'}`}
      >
        {avatarContent}
        {activityIndicator}
      </div>
    );
  }

  /**
   * Render user list
   */
  private _renderUserList(): React.ReactElement {
    const activeUsers = this._getActiveUsers();
    const { config } = this.state;
    
    if (activeUsers.length === 0) {
      return (
        <span 
          className="jp-CollaborationStatusBar-noUsers"
          style={{
            color: 'var(--jp-ui-font-color2)',
            fontSize: '11px',
            fontStyle: 'italic'
          }}
        >
          {this._trans.__('No active collaborators')}
        </span>
      );
    }

    const displayedUsers = activeUsers.slice(0, config.maxDisplayedUsers);
    const remainingCount = activeUsers.length - displayedUsers.length;

    return (
      <div 
        className="jp-CollaborationStatusBar-userList"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '2px'
        }}
      >
        {displayedUsers.map((user, index) => this._renderUserAvatar(user, index))}
        {remainingCount > 0 && (
          <span 
            className="jp-CollaborationStatusBar-moreUsers"
            style={{
              fontSize: '11px',
              color: 'var(--jp-ui-font-color2)',
              marginLeft: '4px'
            }}
          >
            +{remainingCount}
          </span>
        )}
      </div>
    );
  }

  /**
   * Render connection status
   */
  private _renderConnectionStatus(): React.ReactElement {
    const { config } = this.state;
    if (!config.showConnectionStatus) {
      return <></>;
    }

    const connectionHealth = this.props.provider.getConnectionHealth ? this.props.provider.getConnectionHealth() : null;
    const qualityText = connectionHealth ? ` (${connectionHealth.healthy ? 'Good' : 'Poor'})` : '';
    
    const getStatusColor = () => {
      switch (this.state.connectionStatus) {
        case ConnectionStatus.CONNECTED:
          return '#4CAF50'; // Green
        case ConnectionStatus.CONNECTING:
        case ConnectionStatus.RECONNECTING:
          return '#FF9800'; // Orange
        case ConnectionStatus.DISCONNECTED:
        case ConnectionStatus.ERROR:
          return '#F44336'; // Red
        default:
          return '#757575'; // Gray
      }
    };

    const isConnecting = this.state.connectionStatus === ConnectionStatus.CONNECTING || 
                        this.state.connectionStatus === ConnectionStatus.RECONNECTING;
    
    return (
      <div 
        className="jp-CollaborationStatusBar-connectionStatus"
        title={`${this._getConnectionStatusText()}${qualityText}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          fontSize: '12px'
        }}
      >
        <span 
          className={`jp-CollaborationStatusBar-connectionIcon ${isConnecting ? 'jp-mod-spinning' : ''}`}
          style={{
            display: 'inline-block',
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: getStatusColor(),
            animation: isConnecting ? 'jp-CollaborationStatusBar-pulse 1s infinite' : 'none'
          }}
        />
        <span 
          className="jp-CollaborationStatusBar-connectionText"
          style={{
            color: 'var(--jp-ui-font-color1)',
            fontSize: '11px'
          }}
        >
          {this._getConnectionStatusText()}
        </span>
        {connectionHealth && !connectionHealth.healthy && (
          <span 
            className="jp-CollaborationStatusBar-connectionWarning"
            style={{
              color: '#FF9800',
              fontSize: '12px'
            }}
          >
            ⚠
          </span>
        )}
      </div>
    );
  }

  /**
   * Render user count
   */
  private _renderUserCount(): React.ReactElement {
    const { config } = this.state;
    if (!config.showUserCount) {
      return <></>;
    }

    const activeUsers = this._getActiveUsers();
    const userCount = activeUsers.length;

    return (
      <div 
        className="jp-CollaborationStatusBar-userCount"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          color: 'var(--jp-ui-font-color1)',
          fontSize: '12px'
        }}
      >
        <span className="jp-CollaborationStatusBar-userCountIcon">👥</span>
        <span className="jp-CollaborationStatusBar-userCountText">
          {userCount} {userCount === 1 ? this._trans.__('user') : this._trans.__('users')}
        </span>
      </div>
    );
  }

  /**
   * Render session ID
   */
  private _renderSessionId(): React.ReactElement {
    const { config } = this.state;
    if (!config.showSessionId) {
      return <></>;
    }

    const sessionId = this.props.provider?.sessionId || '';
    if (!sessionId) {
      return <></>;
    }

    const shortSessionId = sessionId.length > 8 ? sessionId.substring(0, 8) : sessionId;

    return (
      <div 
        className="jp-CollaborationStatusBar-sessionId"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          fontSize: '11px',
          color: 'var(--jp-ui-font-color2)'
        }}
      >
        <span className="jp-CollaborationStatusBar-sessionIdLabel">
          {this._trans.__('Session:')}
        </span>
        <span 
          className="jp-CollaborationStatusBar-sessionIdValue" 
          title={sessionId}
          style={{
            fontFamily: 'monospace',
            backgroundColor: 'var(--jp-layout-color2)',
            padding: '2px 4px',
            borderRadius: '2px',
            fontSize: '10px'
          }}
        >
          {shortSessionId}
        </span>
      </div>
    );
  }

  /**
   * Render options menu button
   */
  private _renderOptionsButton(): React.ReactElement {
    const { config } = this.state;
    if (!config.showOptionsMenu) {
      return <></>;
    }

    return (
      <button
        className="jp-CollaborationStatusBar-optionsButton"
        onClick={this._handleOptionsClick}
        onKeyDown={this._handleOptionsKeyDown}
        title={this._trans.__('Collaboration options')}
        aria-label={this._trans.__('Open collaboration options menu')}
        tabIndex={0}
        style={{
          background: 'none',
          border: 'none',
          padding: '4px',
          borderRadius: '3px',
          cursor: 'pointer',
          color: 'var(--jp-ui-font-color2)',
          fontSize: '12px',
          marginLeft: 'auto'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = 'var(--jp-layout-color2)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'transparent';
        }}
        onFocus={(e) => {
          e.currentTarget.style.backgroundColor = 'var(--jp-layout-color2)';
        }}
        onBlur={(e) => {
          e.currentTarget.style.backgroundColor = 'transparent';
        }}
      >
        <span className="jp-CollaborationStatusBar-optionsIcon">⋯</span>
      </button>
    );
  }

  /**
   * Render the component
   */
  render(): React.ReactElement {
    const { className, style } = this.props;
    const { config } = this.state;

    const baseClassName = 'jp-CollaborationStatusBar';
    const fullClassName = className ? `${baseClassName} ${className}` : baseClassName;

    const baseStyle: React.CSSProperties = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '4px 8px',
      backgroundColor: 'var(--jp-layout-color1)',
      borderTop: '1px solid var(--jp-border-color1)',
      fontSize: '12px',
      lineHeight: '1.2',
      minHeight: '24px',
      boxSizing: 'border-box',
      ...style
    };

    if (config.compactMode) {
      return (
        <div 
          className={`${fullClassName} jp-mod-compact`} 
          style={{
            ...baseStyle,
            gap: '4px',
            padding: '2px 4px'
          }}
        >
          {this._renderConnectionStatus()}
          {this._renderUserCount()}
          {this._renderOptionsButton()}
        </div>
      );
    }

    return (
      <div 
        className={fullClassName} 
        style={baseStyle}
      >
        {this._renderConnectionStatus()}
        {this._renderUserList()}
        {this._renderUserCount()}
        {this._renderSessionId()}
        {this._renderOptionsButton()}
      </div>
    );
  }
}

/**
 * CollaborationStatusBarComponent namespace with factory methods
 */
export namespace CollaborationStatusBarComponent {
  /**
   * Create a new collaboration status bar widget
   */
  export function create(props: ICollaborationStatusBarProps): ReactWidget {
    return ReactWidget.create(
      <CollaborationStatusBar {...props} />
    );
  }
}