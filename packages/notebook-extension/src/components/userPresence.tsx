// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import React, { useState, useEffect, useCallback } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator } from '@jupyterlab/translation';
import { Button } from '@jupyterlab/ui-components';
import { Time } from '@jupyterlab/coreutils';
import { UserAwareness, IUser, ConnectionStatus, UserActivityType } from '../../notebook/src/collab/awareness';
import { YjsNotebookProvider } from '../../notebook/src/collab/provider';

// CSS styles for the UserPresence component
const USER_PRESENCE_STYLES = `
  .jp-UserPresence-panel {
    background: var(--jp-layout-color1);
    border-left: 1px solid var(--jp-border-color2);
    display: flex;
    flex-direction: column;
    min-height: 200px;
    max-height: 600px;
    width: 280px;
    font-family: var(--jp-ui-font-family);
    font-size: var(--jp-ui-font-size1);
    color: var(--jp-ui-font-color1);
    overflow: hidden;
  }

  .jp-UserPresence-collapsed {
    background: var(--jp-layout-color1);
    border-left: 1px solid var(--jp-border-color2);
    width: 48px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .jp-UserPresence-toggleButton {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    transition: background-color 0.2s;
    display: flex;
    flex-direction: column;
    align-items: center;
    font-size: 12px;
  }

  .jp-UserPresence-toggleButton:hover {
    background: var(--jp-layout-color2);
  }

  .jp-UserPresence-userCount {
    font-size: 10px;
    color: var(--jp-ui-font-color2);
    margin-bottom: 2px;
  }

  .jp-UserPresence-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid var(--jp-border-color2);
    background: var(--jp-layout-color2);
    min-height: 32px;
  }

  .jp-UserPresence-title {
    display: flex;
    align-items: center;
    font-weight: 600;
    font-size: 13px;
    color: var(--jp-ui-font-color1);
  }

  .jp-UserPresence-title .jp-UserPresence-icon {
    margin-right: 6px;
  }

  .jp-UserPresence-controls {
    display: flex;
    align-items: center;
  }

  .jp-UserPresence-collapseButton {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 4px;
    border-radius: 2px;
    font-size: 12px;
    color: var(--jp-ui-font-color2);
    transition: background-color 0.2s;
  }

  .jp-UserPresence-collapseButton:hover {
    background: var(--jp-layout-color3);
  }

  .jp-UserPresence-userList {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }

  .jp-UserPresence-user {
    padding: 8px 12px;
    cursor: pointer;
    border-bottom: 1px solid var(--jp-border-color3);
    transition: background-color 0.2s;
  }

  .jp-UserPresence-user:hover {
    background: var(--jp-layout-color2);
  }

  .jp-UserPresence-user.jp-connected {
    opacity: 1;
  }

  .jp-UserPresence-user.jp-disconnected {
    opacity: 0.6;
  }

  .jp-UserPresence-userInfo {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .jp-UserPresence-userIndicator {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .jp-UserPresence-userDot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 8px;
    border: 1px solid var(--jp-border-color2);
  }

  .jp-UserPresence-userName {
    font-weight: 500;
    font-size: 12px;
    color: var(--jp-ui-font-color1);
    flex: 1;
  }

  .jp-UserPresence-userColor {
    display: flex;
    align-items: center;
  }

  .jp-UserPresence-colorChip {
    width: 16px;
    height: 16px;
    border-radius: 2px;
    border: 1px solid var(--jp-border-color2);
  }

  .jp-UserPresence-userActivity {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: 20px;
  }

  .jp-UserPresence-activityIcon {
    font-size: 12px;
    opacity: 0.8;
  }

  .jp-UserPresence-activityText {
    font-size: 11px;
    color: var(--jp-ui-font-color2);
  }

  .jp-UserPresence-userTimestamp {
    margin-left: 20px;
  }

  .jp-UserPresence-lastActive {
    font-size: 10px;
    color: var(--jp-ui-font-color3);
  }

  .jp-UserPresence-legend {
    border-top: 1px solid var(--jp-border-color2);
    padding: 8px 12px;
    background: var(--jp-layout-color2);
  }

  .jp-UserPresence-legendTitle {
    display: flex;
    align-items: center;
    font-weight: 500;
    font-size: 11px;
    color: var(--jp-ui-font-color1);
    margin-bottom: 6px;
  }

  .jp-UserPresence-legendIcon {
    margin-right: 4px;
  }

  .jp-UserPresence-legendItems {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .jp-UserPresence-legendItem {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    color: var(--jp-ui-font-color2);
  }

  .jp-UserPresence-legendSymbol {
    font-size: 12px;
    width: 12px;
    text-align: center;
  }

  .jp-UserPresence-controlButton {
    margin: 8px 12px;
    padding: 4px 8px;
    font-size: 11px;
    border-radius: 4px;
    border: 1px solid var(--jp-border-color2);
    background: var(--jp-layout-color1);
    color: var(--jp-ui-font-color1);
    cursor: pointer;
    transition: all 0.2s;
  }

  .jp-UserPresence-controlButton:hover {
    background: var(--jp-layout-color2);
    border-color: var(--jp-border-color1);
  }

  .jp-UserPresence-controlButton:active {
    background: var(--jp-layout-color3);
  }

  /* Animation styles */
  .jp-UserPresence-user {
    transition: all 0.2s ease-in-out;
  }

  .jp-UserPresence-userDot {
    transition: background-color 0.3s ease;
  }

  .jp-UserPresence-colorChip {
    transition: all 0.2s ease;
  }

  /* Dark theme adjustments */
  [data-jp-theme-name="JupyterLab Dark"] .jp-UserPresence-panel {
    background: var(--jp-layout-color1);
    border-left-color: var(--jp-border-color2);
  }

  [data-jp-theme-name="JupyterLab Dark"] .jp-UserPresence-header {
    background: var(--jp-layout-color2);
  }

  [data-jp-theme-name="JupyterLab Dark"] .jp-UserPresence-legend {
    background: var(--jp-layout-color2);
  }

  /* Accessibility improvements */
  .jp-UserPresence-toggleButton:focus,
  .jp-UserPresence-collapseButton:focus,
  .jp-UserPresence-controlButton:focus {
    outline: 2px solid var(--jp-brand-color1);
    outline-offset: 2px;
  }

  /* Responsive design for narrow screens */
  @media (max-width: 768px) {
    .jp-UserPresence-panel {
      width: 240px;
    }
  }
`;

// Inject styles into the document head
const styleSheet = document.createElement('style');
styleSheet.type = 'text/css';
styleSheet.textContent = USER_PRESENCE_STYLES;
document.head.appendChild(styleSheet);

/**
 * Interface for user activity display information
 */
export interface IUserActivity {
  /** User identifier */
  userId: string;
  /** Username for display */
  username: string;
  /** User color for visual indicators */
  color: string;
  /** Current cursor position information */
  cursorPosition?: {
    cellId: string;
    line: number;
    column: number;
  };
  /** Current text selection */
  selection?: {
    cellId: string;
    text: string;
  };
  /** Current activity status */
  activityStatus: UserActivityType;
  /** Cell ID being worked on */
  cellId?: string;
  /** Timestamp of last activity */
  lastActive: number;
  /** Whether user is currently connected */
  isConnected: boolean;
}

/**
 * Interface for visual settings of the presence display
 */
export interface IPresenceVisualSettings {
  /** Show cursor indicators */
  showCursors: boolean;
  /** Show text selection indicators */
  showSelections: boolean;
  /** Show user avatars */
  showAvatars: boolean;
  /** Show activity status indicators */
  showActivityStatus: boolean;
  /** Color scheme for user indicators */
  colorScheme: 'vibrant' | 'subtle' | 'monochrome';
  /** Animate changes in presence */
  animateChanges: boolean;
  /** Maximum number of users to display */
  maxDisplayedUsers: number;
}

/**
 * Props interface for UserPresence component
 */
export interface IUserPresenceProps {
  /** List of users to display */
  users: IUserActivity[];
  /** Visual settings for the presence display */
  visualSettings: IPresenceVisualSettings;
  /** Whether the sidebar is collapsed */
  isCollapsed: boolean;
  /** Whether to show inactive users */
  showInactiveUsers: boolean;
  /** Translator for internationalization */
  translator: ITranslator;
  /** Callback when sidebar is toggled */
  onToggleSidebar: () => void;
  /** Callback when inactive users toggle changes */
  onToggleInactiveUsers: () => void;
  /** Callback when user is selected */
  onUserSelect: (userId: string) => void;
}

/**
 * Interface for UserPresence component state
 */
interface IUserPresenceState {
  isCollapsed: boolean;
  showInactiveUsers: boolean;
  selectedUserId: string | null;
  activityFilter: string;
  sortBy: string;
  showPresence: boolean;
}

/**
 * UserPresence component that visualizes user presence in collaborative editing sessions
 * 
 * This component displays a collapsible sidebar showing collaborator avatars, cursor colors,
 * and cell focus locations. It provides real-time visualization of user activity with
 * user-specific colors for cursors and selections.
 */
export default class UserPresence extends React.Component<IUserPresenceProps, IUserPresenceState> {
  private _awareness: UserAwareness | null = null;
  private _provider: YjsNotebookProvider | null = null;
  private _activityTimeoutId: number | null = null;
  private _userActivityMap = new Map<string, IUserActivity>();

  /**
   * Construct a new UserPresence component
   */
  constructor(props: IUserPresenceProps) {
    super(props);
    this.state = {
      isCollapsed: props.isCollapsed,
      showInactiveUsers: props.showInactiveUsers,
      selectedUserId: null,
      activityFilter: 'all',
      sortBy: 'activity',
      showPresence: true
    };
  }

  /**
   * Component did mount lifecycle method
   */
  componentDidMount(): void {
    this._setupPresenceTracking();
    this._startActivityMonitoring();
  }

  /**
   * Component will unmount lifecycle method
   */
  componentWillUnmount(): void {
    this._cleanupPresenceTracking();
    this._stopActivityMonitoring();
  }

  /**
   * Set up presence tracking with awareness system
   */
  private _setupPresenceTracking(): void {
    // Initialize awareness system connection
    // Note: In a real implementation, this would be passed via props or context
    // The awareness system would be initialized with the YjsNotebookProvider
    // and connected to the WebSocket for real-time updates
    
    // Example integration:
    // this._awareness = new UserAwareness(this._provider);
    // this._awareness.onUsersChanged.connect(this._handleUsersChanged);
    // this._awareness.onConnectionStatusChanged.connect(this._handleConnectionStatusChanged);
    
    this._startActivityMonitoring();
  }

  /**
   * Clean up presence tracking
   */
  private _cleanupPresenceTracking(): void {
    if (this._awareness) {
      this._awareness.dispose();
      this._awareness = null;
    }
  }

  /**
   * Handle users changed event from awareness system
   */
  private _handleUsersChanged = (sender: UserAwareness, users: Map<string, IUser>): void => {
    // Convert IUser to IUserActivity for display
    const userActivities: IUserActivity[] = Array.from(users.values()).map(user => ({
      userId: user.userId,
      username: user.username,
      color: user.color,
      cursorPosition: user.cursorPosition ? {
        cellId: user.cursorPosition.cellId,
        line: user.cursorPosition.line,
        column: user.cursorPosition.column
      } : undefined,
      selection: user.selection ? {
        cellId: user.selection.cellId,
        text: user.selection.text
      } : undefined,
      activityStatus: user.activity,
      cellId: user.currentCell,
      lastActive: user.lastSeen,
      isConnected: user.connectionStatus === ConnectionStatus.CONNECTED
    }));

    // Update internal activity map
    userActivities.forEach(activity => {
      this._userActivityMap.set(activity.userId, activity);
    });

    // Trigger re-render
    this.forceUpdate();
  };

  /**
   * Handle connection status changed event from awareness system
   */
  private _handleConnectionStatusChanged = (sender: UserAwareness, status: ConnectionStatus): void => {
    // Update component state based on connection status
    this.forceUpdate();
  };

  /**
   * Start monitoring user activity
   */
  private _startActivityMonitoring(): void {
    this._activityTimeoutId = window.setInterval(() => {
      this._updateUserActivity();
    }, 1000); // Update every second
  }

  /**
   * Stop monitoring user activity
   */
  private _stopActivityMonitoring(): void {
    if (this._activityTimeoutId) {
      clearInterval(this._activityTimeoutId);
      this._activityTimeoutId = null;
    }
  }

  /**
   * Update user activity tracking
   */
  private _updateUserActivity(): void {
    const { users } = this.props;
    
    // Process each user to update their activity status
    users.forEach(user => {
      const now = Date.now();
      const timeSinceActivity = now - user.lastActive;
      
      // Update activity status based on time since last activity
      let newActivityStatus = user.activityStatus;
      if (timeSinceActivity > 300000) { // 5 minutes
        newActivityStatus = UserActivityType.IDLE;
      } else if (timeSinceActivity > 60000) { // 1 minute
        newActivityStatus = UserActivityType.VIEWING;
      }
      
      // Update the user activity map
      this._userActivityMap.set(user.userId, {
        ...user,
        activityStatus: newActivityStatus
      });
    });
    
    // Trigger re-render if needed
    this.forceUpdate();
  }

  /**
   * Get activity icon for user status
   */
  private _getActivityIcon(activity: UserActivityType): string {
    switch (activity) {
      case UserActivityType.EDITING:
        return '✏️';
      case UserActivityType.VIEWING:
        return '👁️';
      case UserActivityType.EXECUTING:
        return '⚡';
      case UserActivityType.TYPING:
        return '⌨️';
      case UserActivityType.SELECTING:
        return '🎯';
      case UserActivityType.COMMENTING:
        return '💬';
      case UserActivityType.IDLE:
        return '😴';
      case UserActivityType.OFFLINE:
        return '📴';
      default:
        return '👤';
    }
  }

  /**
   * Get connection status indicator
   */
  private _getConnectionIndicator(isConnected: boolean): string {
    return isConnected ? '🟢' : '🔴';
  }

  /**
   * Get formatted activity description
   */
  private _getActivityDescription(user: IUserActivity): string {
    const { translator } = this.props;
    const trans = translator.load('notebook');
    
    if (user.cellId) {
      const cellType = 'Code'; // Would be determined from cell metadata
      switch (user.activityStatus) {
        case UserActivityType.EDITING:
          return trans.__('Cell %1 (%2) - Editing', user.cellId, cellType);
        case UserActivityType.VIEWING:
          return trans.__('Cell %1 (%2) - Viewing', user.cellId, cellType);
        case UserActivityType.EXECUTING:
          return trans.__('Cell %1 (%2) - Running', user.cellId, cellType);
        case UserActivityType.TYPING:
          return trans.__('Cell %1 (%2) - Typing', user.cellId, cellType);
        default:
          return trans.__('Cell %1 (%2)', user.cellId, cellType);
      }
    }
    
    return trans.__(this._getActivityStatusText(user.activityStatus));
  }

  /**
   * Get activity status text
   */
  private _getActivityStatusText(activity: UserActivityType): string {
    switch (activity) {
      case UserActivityType.EDITING:
        return 'Editing';
      case UserActivityType.VIEWING:
        return 'Viewing';
      case UserActivityType.EXECUTING:
        return 'Running';
      case UserActivityType.TYPING:
        return 'Typing';
      case UserActivityType.SELECTING:
        return 'Selecting';
      case UserActivityType.COMMENTING:
        return 'Commenting';
      case UserActivityType.IDLE:
        return 'Idle';
      case UserActivityType.OFFLINE:
        return 'Offline';
      default:
        return 'Active';
    }
  }

  /**
   * Get filtered and sorted users
   */
  private _getFilteredUsers(): IUserActivity[] {
    const { users, showInactiveUsers } = this.props;
    
    let filteredUsers = users;
    
    // Filter by activity status
    if (!showInactiveUsers) {
      filteredUsers = filteredUsers.filter(user => 
        user.isConnected && user.activityStatus !== UserActivityType.IDLE
      );
    }
    
    // Sort users by activity time (most recent first)
    filteredUsers.sort((a, b) => b.lastActive - a.lastActive);
    
    return filteredUsers;
  }

  /**
   * Handle user selection
   */
  private _handleUserSelect = (userId: string): void => {
    this.props.onUserSelect(userId);
  };

  /**
   * Handle sidebar toggle
   */
  private _handleToggleSidebar = (): void => {
    this.props.onToggleSidebar();
  };

  /**
   * Handle inactive users toggle
   */
  private _handleToggleInactiveUsers = (): void => {
    this.props.onToggleInactiveUsers();
  };

  /**
   * Show presence indicators
   */
  showPresence(): void {
    // Implementation to show presence indicators
    // This would typically update component state to show presence
    this.setState({ showPresence: true });
  }

  /**
   * Hide presence indicators
   */
  hidePresence(): void {
    // Implementation to hide presence indicators
    // This would typically update component state to hide presence
    this.setState({ showPresence: false });
  }

  /**
   * Update user activity display
   */
  updateUserActivity(userId: string, activity: IUserActivity): void {
    this._userActivityMap.set(userId, activity);
    this.forceUpdate();
  }

  /**
   * Toggle sidebar visibility
   */
  toggleSidebar(): void {
    this._handleToggleSidebar();
  }

  /**
   * Toggle inactive users display
   */
  toggleInactiveUsers(): void {
    this._handleToggleInactiveUsers();
  }

  /**
   * Access to component props for external integration
   */
  get users(): IUserActivity[] {
    return this.props.users;
  }

  get visualSettings(): IPresenceVisualSettings {
    return this.props.visualSettings;
  }

  get isCollapsed(): boolean {
    return this.props.isCollapsed;
  }

  get showInactiveUsers(): boolean {
    return this.props.showInactiveUsers;
  }

  get translator(): ITranslator {
    return this.props.translator;
  }

  /**
   * Render the component
   */
  render(): JSX.Element {
    const { isCollapsed, translator, visualSettings } = this.props;
    const trans = translator.load('notebook');
    const filteredUsers = this._getFilteredUsers();

    if (isCollapsed) {
      return (
        <div className="jp-UserPresence-collapsed">
          <button 
            className="jp-UserPresence-toggleButton"
            onClick={this._handleToggleSidebar}
            title={trans.__('Show collaborators')}
          >
            <span className="jp-UserPresence-userCount">
              {filteredUsers.length}
            </span>
            <span className="jp-UserPresence-icon">👤</span>
          </button>
        </div>
      );
    }

    return (
      <div className="jp-UserPresence-panel">
        <div className="jp-UserPresence-header">
          <div className="jp-UserPresence-title">
            <span className="jp-UserPresence-icon">👤</span>
            <span>{trans.__('Collaborators')} [{filteredUsers.length}]</span>
          </div>
          <div className="jp-UserPresence-controls">
            <button 
              className="jp-UserPresence-collapseButton"
              onClick={this._handleToggleSidebar}
              title={trans.__('Collapse panel')}
            >
              ↑ ↓
            </button>
          </div>
        </div>

        <div className="jp-UserPresence-userList">
          {filteredUsers.map(user => (
            <div 
              key={user.userId}
              className={`jp-UserPresence-user ${user.isConnected ? 'jp-connected' : 'jp-disconnected'}`}
              onClick={() => this._handleUserSelect(user.userId)}
            >
              <div className="jp-UserPresence-userInfo">
                <div className="jp-UserPresence-userIndicator">
                  <span 
                    className="jp-UserPresence-userDot"
                    style={{ backgroundColor: user.color }}
                  >
                    {this._getConnectionIndicator(user.isConnected)}
                  </span>
                  <span className="jp-UserPresence-userName">
                    {user.username}
                  </span>
                  <span className="jp-UserPresence-userColor">
                    <div 
                      className="jp-UserPresence-colorChip"
                      style={{ backgroundColor: user.color }}
                    />
                  </span>
                </div>
                <div className="jp-UserPresence-userActivity">
                  <span className="jp-UserPresence-activityIcon">
                    {this._getActivityIcon(user.activityStatus)}
                  </span>
                  <span className="jp-UserPresence-activityText">
                    {this._getActivityDescription(user)}
                  </span>
                </div>
                <div className="jp-UserPresence-userTimestamp">
                  <span className="jp-UserPresence-lastActive">
                    {Time.formatHuman(new Date(user.lastActive))}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="jp-UserPresence-legend">
          <div className="jp-UserPresence-legendTitle">
            <span className="jp-UserPresence-legendIcon">📎</span>
            <span>{trans.__('Legend:')}</span>
          </div>
          <div className="jp-UserPresence-legendItems">
            <div className="jp-UserPresence-legendItem">
              <span className="jp-UserPresence-legendSymbol">●</span>
              <span>{trans.__('Active in notebook')}</span>
            </div>
            <div className="jp-UserPresence-legendItem">
              <span className="jp-UserPresence-legendSymbol">○</span>
              <span>{trans.__('Connected but inactive')}</span>
            </div>
            <div className="jp-UserPresence-legendItem">
              <span className="jp-UserPresence-legendSymbol">⊗</span>
              <span>{trans.__('Connection issues')}</span>
            </div>
          </div>
        </div>

        <div className="jp-UserPresence-controls">
          <Button 
            className="jp-UserPresence-controlButton"
            onClick={this._handleToggleInactiveUsers}
            minimal={true}
            size="small"
          >
            {this.props.showInactiveUsers 
              ? trans.__('Hide inactive users') 
              : trans.__('Show inactive users')
            }
          </Button>
        </div>
      </div>
    );
  }
}

/**
 * Namespace for UserPresence component functionality
 */
export namespace UserPresence {
  /**
   * Create a new UserPresence widget
   */
  export const create = (props: IUserPresenceProps): ReactWidget => {
    return ReactWidget.create(<UserPresence {...props} />);
  };

  /**
   * Default visual settings for the presence display
   */
  export const defaultVisualSettings: IPresenceVisualSettings = {
    showCursors: true,
    showSelections: true,
    showAvatars: true,
    showActivityStatus: true,
    colorScheme: 'vibrant',
    animateChanges: true,
    maxDisplayedUsers: 50
  };

  /**
   * Create default props for the UserPresence component
   */
  export const createDefaultProps = (translator: ITranslator): Partial<IUserPresenceProps> => {
    return {
      users: [],
      visualSettings: defaultVisualSettings,
      isCollapsed: false,
      showInactiveUsers: false,
      translator,
      onToggleSidebar: () => {},
      onToggleInactiveUsers: () => {},
      onUserSelect: () => {}
    };
  };
}