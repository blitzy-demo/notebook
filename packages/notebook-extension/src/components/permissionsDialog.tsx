/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * Permission management dialog component for configuring user access levels in collaborative sessions.
 * Provides UI for viewing current permissions, inviting new collaborators, changing roles (view-only, edit, admin),
 * and revoking access. Integrates with PermissionManager and JupyterHub authentication.
 */

import React, { useState, useEffect } from 'react';
import { showErrorMessage } from '@jupyterlab/apputils';
import { ITranslator } from '@jupyterlab/translation';
import { closeIcon } from '@jupyterlab/ui-components';

import { PermissionManager } from '@jupyter-notebook/notebook/lib/collab/permissions';
import { CollaborativeRole } from '@jupyter-notebook/notebook/lib/tokens';

/**
 * Interface defining props for the PermissionsDialog component
 */
export interface IPermissionsDialogProps {
  /**
   * Permission manager instance for role-based access control operations
   */
  permissionManager: PermissionManager;

  /**
   * Path to the notebook file being managed
   */
  notebookPath: string;

  /**
   * Translation service for internationalization
   */
  translator: ITranslator;

  /**
   * Current user ID for permission checks
   */
  currentUserId?: string;

  /**
   * Callback function called when dialog is closed
   */
  onClose?: () => void;

  /**
   * Callback function called when permissions are updated
   */
  onPermissionsUpdated?: (permissions: Record<string, CollaborativeRole>) => void;
}

/**
 * Interface representing a user in the permissions dialog
 */
interface IPermissionUser {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  role: CollaborativeRole;
  lastActivity: Date;
  isActive: boolean;
}

/**
 * Interface for pending permission changes
 */
interface IPendingChange {
  userId: string;
  newRole: CollaborativeRole;
  action: 'update' | 'invite' | 'revoke';
}

/**
 * Main PermissionsDialog React component for collaborative permission management
 */
export function PermissionsDialog(props: IPermissionsDialogProps): JSX.Element {
  const {
    permissionManager,
    notebookPath,
    translator,
    currentUserId = 'current-user',
    onClose,
    onPermissionsUpdated
  } = props;

  const trans = translator.load('notebook');

  // State management
  const [activeTab, setActiveTab] = useState<'users' | 'invite' | 'settings'>('users');
  const [userList, setUserList] = useState<IPermissionUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [newUserEmail, setNewUserEmail] = useState<string>('');
  const [pendingChanges, setPendingChanges] = useState<IPendingChange[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isCurrentUserAdmin, setIsCurrentUserAdmin] = useState<boolean>(false);
  const [pendingInvitations, setPendingInvitations] = useState<Array<{email: string; role: CollaborativeRole; timestamp: Date}>>([]);
  const [defaultRole, setDefaultRole] = useState<CollaborativeRole>(CollaborativeRole.VIEWER);
  const [guestAccessEnabled, setGuestAccessEnabled] = useState<boolean>(false);
  const [auditLog, setAuditLog] = useState<any[]>([]);

  // Fetch current permissions and user data on mount
  useEffect(() => {
    const fetchPermissions = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // Check if current user has admin permissions
        const adminCheck = await permissionManager.isAdmin(currentUserId);
        setIsCurrentUserAdmin(adminCheck);

        // Get cached permissions for performance
        const cachedPermissions = permissionManager.getCachedPermissions();
        const users: IPermissionUser[] = [];

        for (const [userId, role] of cachedPermissions.entries()) {
          users.push({
            userId,
            username: userId, // In real implementation, this would be fetched from user service
            displayName: userId,
            avatar: `https://www.gravatar.com/avatar/${userId}?d=identicon&s=32`,
            role,
            lastActivity: new Date(),
            isActive: true
          });
        }

        setUserList(users);

        // Fetch audit log if admin
        if (adminCheck) {
          const logs = await permissionManager.auditLog();
          setAuditLog(logs);
        }

      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to load permissions';
        setError(errorMessage);
        await showErrorMessage('Permission Load Error', errorMessage);
      } finally {
        setIsLoading(false);
      }
    };

    fetchPermissions();

    // Set up real-time permission change listener
    const handlePermissionChange = (data: { userId: string; newRole: CollaborativeRole; previousRole: CollaborativeRole }) => {
      setUserList(prevUsers => {
        const updatedUsers = [...prevUsers];
        const userIndex = updatedUsers.findIndex(u => u.userId === data.userId);

        if (userIndex >= 0) {
          updatedUsers[userIndex] = { ...updatedUsers[userIndex], role: data.newRole };
        } else {
          // Add new user
          updatedUsers.push({
            userId: data.userId,
            username: data.userId,
            displayName: data.userId,
            avatar: `https://www.gravatar.com/avatar/${data.userId}?d=identicon&s=32`,
            role: data.newRole,
            lastActivity: new Date(),
            isActive: true
          });
        }

        return updatedUsers;
      });
    };

    permissionManager.onPermissionChange.connect(handlePermissionChange);

    return () => {
      permissionManager.onPermissionChange.disconnect(handlePermissionChange);
    };
  }, [permissionManager, currentUserId, translator]);

  // Handle role change for existing user
  const handleRoleChange = async (userId: string, newRole: CollaborativeRole) => {
    if (!isCurrentUserAdmin) {
      await showErrorMessage('Access Denied', trans.__('Only administrators can change user permissions.'));
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const previousRole = await permissionManager.getUserRole(userId);

      // Add to pending changes
      const pendingChange: IPendingChange = {
        userId,
        newRole,
        action: 'update'
      };

      setPendingChanges(prev => {
        const filtered = prev.filter(c => c.userId !== userId);
        return [...filtered, pendingChange];
      });

      // Apply the change immediately
      await permissionManager.setPermission(userId, 'role', true);
      await permissionManager.updatePermissions({ [userId]: newRole });

      // Update local state
      setUserList(prevUsers =>
        prevUsers.map(user =>
          user.userId === userId ? { ...user, role: newRole } : user
        )
      );

      // Remove from pending changes after successful update
      setPendingChanges(prev => prev.filter(c => c.userId !== userId));

      // Notify parent component
      if (onPermissionsUpdated) {
        const updatedPermissions: Record<string, CollaborativeRole> = {};
        userList.forEach(user => {
          updatedPermissions[user.userId] = user.userId === userId ? newRole : user.role;
        });
        onPermissionsUpdated(updatedPermissions);
      }

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to update user role';
      setError(errorMessage);
      await showErrorMessage('Role Update Error', errorMessage);

      // Remove from pending changes on error
      setPendingChanges(prev => prev.filter(c => c.userId !== userId));
    } finally {
      setIsLoading(false);
    }
  };

  // Handle user removal with confirmation
  const handleRemoveUser = async (userId: string) => {
    if (!isCurrentUserAdmin) {
      await showErrorMessage('Access Denied', trans.__('Only administrators can remove users.'));
      return;
    }

    const confirmRemoval = window.confirm(
      trans.__('Are you sure you want to remove this user\'s access to the notebook?')
    );

    if (!confirmRemoval) {
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      await permissionManager.revokePermission(userId);

      // Update local state
      setUserList(prevUsers => prevUsers.filter(user => user.userId !== userId));

      // Update pending changes
      setPendingChanges(prev => prev.filter(c => c.userId !== userId));

      // Notify parent component
      if (onPermissionsUpdated) {
        const updatedPermissions: Record<string, CollaborativeRole> = {};
        userList.filter(u => u.userId !== userId).forEach(user => {
          updatedPermissions[user.userId] = user.role;
        });
        onPermissionsUpdated(updatedPermissions);
      }

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to remove user';
      setError(errorMessage);
      await showErrorMessage('User Removal Error', errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  // Handle new user invitation
  const handleInviteUser = async () => {
    if (!isCurrentUserAdmin) {
      await showErrorMessage('Access Denied', trans.__('Only administrators can invite users.'));
      return;
    }

    if (!newUserEmail.trim()) {
      await showErrorMessage('Invalid Input', trans.__('Please enter a valid email address.'));
      return;
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newUserEmail.trim())) {
      await showErrorMessage('Invalid Email', trans.__('Please enter a valid email address.'));
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const newUserId = newUserEmail.trim().toLowerCase();

      // Check if user already exists
      const existingUser = userList.find(u => u.userId === newUserId || u.username === newUserId);
      if (existingUser) {
        await showErrorMessage('User Exists', trans.__('This user already has access to the notebook.'));
        return;
      }

      // Add to pending invitations
      const invitation = {
        email: newUserEmail.trim(),
        role: defaultRole,
        timestamp: new Date()
      };
      setPendingInvitations(prev => [...prev, invitation]);

      // Grant permission to the new user
      await permissionManager.setPermission(newUserId, 'role', true);
      await permissionManager.updatePermissions({ [newUserId]: defaultRole });

      // Add to user list
      const newUser: IPermissionUser = {
        userId: newUserId,
        username: newUserId,
        displayName: newUserId,
        avatar: `https://www.gravatar.com/avatar/${newUserId}?d=identicon&s=32`,
        role: defaultRole,
        lastActivity: new Date(),
        isActive: false
      };

      setUserList(prevUsers => [...prevUsers, newUser]);
      setNewUserEmail('');

      // Sync with JupyterHub if available
      try {
        await permissionManager.syncWithJupyterHub();
      } catch (syncErr) {
        console.warn('JupyterHub sync failed:', syncErr);
      }

      // Notify parent component
      if (onPermissionsUpdated) {
        const updatedPermissions: Record<string, CollaborativeRole> = {};
        [...userList, newUser].forEach(user => {
          updatedPermissions[user.userId] = user.role;
        });
        onPermissionsUpdated(updatedPermissions);
      }

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to invite user';
      setError(errorMessage);
      await showErrorMessage('Invitation Error', errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  // Get role display label
  const getRoleLabel = (role: CollaborativeRole): string => {
    switch (role) {
      case CollaborativeRole.ADMIN:
        return trans.__('Admin');
      case CollaborativeRole.EDITOR:
        return trans.__('Editor');
      case CollaborativeRole.VIEWER:
        return trans.__('Viewer');
      default:
        return trans.__('Unknown');
    }
  };

  // Get role description
  const getRoleDescription = (role: CollaborativeRole): string => {
    switch (role) {
      case CollaborativeRole.ADMIN:
        return trans.__('Full control including permission management');
      case CollaborativeRole.EDITOR:
        return trans.__('Full editing with cell execution');
      case CollaborativeRole.VIEWER:
        return trans.__('Read access and commenting only');
      default:
        return '';
    }
  };

  // Render current users tab
  const renderCurrentUsersTab = () => (
    <div className="jp-PermissionsDialog-userList">
      <div className="jp-PermissionsDialog-header">
        <h3>{trans.__('Current Collaborators')}</h3>
        {userList.length > 0 && (
          <p className="jp-PermissionsDialog-subtext">
            {trans.__(`${userList.length} user(s) have access to this notebook`)}
          </p>
        )}
      </div>

      {userList.length === 0 ? (
        <div className="jp-PermissionsDialog-empty">
          <p>{trans.__('No collaborators found. Use the Invite Users tab to add collaborators.')}</p>
        </div>
      ) : (
        <div className="jp-PermissionsDialog-userGrid">
          {userList.map(user => (
            <div key={user.userId} className="jp-PermissionsDialog-userRow">
              <div className="jp-PermissionsDialog-userInfo">
                <img
                  src={user.avatar}
                  alt={user.displayName}
                  className="jp-PermissionsDialog-avatar"
                />
                <div className="jp-PermissionsDialog-userDetails">
                  <span className="jp-PermissionsDialog-userName">{user.displayName}</span>
                  <span className="jp-PermissionsDialog-userEmail">{user.username}</span>
                  <span className="jp-PermissionsDialog-lastActive">
                    {user.isActive ? trans.__('Active') : trans.__(`Last active: ${user.lastActivity.toLocaleDateString()}`)}
                  </span>
                </div>
              </div>

              <div className="jp-PermissionsDialog-roleControls">
                {isCurrentUserAdmin && user.userId !== currentUserId ? (
                  <>
                    <select
                      className="jp-PermissionsDialog-roleSelector"
                      value={user.role}
                      onChange={(e) => handleRoleChange(user.userId, e.target.value as CollaborativeRole)}
                      disabled={isLoading}
                    >
                      <option value={CollaborativeRole.VIEWER}>
                        {getRoleLabel(CollaborativeRole.VIEWER)}
                      </option>
                      <option value={CollaborativeRole.EDITOR}>
                        {getRoleLabel(CollaborativeRole.EDITOR)}
                      </option>
                      <option value={CollaborativeRole.ADMIN}>
                        {getRoleLabel(CollaborativeRole.ADMIN)}
                      </option>
                    </select>

                    <button
                      className="jp-PermissionsDialog-removeButton"
                      onClick={() => handleRemoveUser(user.userId)}
                      disabled={isLoading}
                      title={trans.__('Remove user access')}
                    >
                      <closeIcon.react />
                    </button>
                  </>
                ) : (
                  <span className="jp-PermissionsDialog-roleLabel">
                    {getRoleLabel(user.role)}
                    {user.userId === currentUserId && (
                      <span className="jp-PermissionsDialog-currentUser"> ({trans.__('You')})</span>
                    )}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  // Render invite users tab
  const renderInviteUsersTab = () => (
    <div className="jp-PermissionsDialog-inviteSection">
      <div className="jp-PermissionsDialog-header">
        <h3>{trans.__('Invite New Collaborators')}</h3>
        <p className="jp-PermissionsDialog-subtext">
          {trans.__('Add new users to collaborate on this notebook')}
        </p>
      </div>

      {isCurrentUserAdmin ? (
        <>
          <div className="jp-PermissionsDialog-inviteForm">
            <div className="jp-PermissionsDialog-inputGroup">
              <label htmlFor="newUserEmail">{trans.__('Email or Username:')}</label>
              <input
                id="newUserEmail"
                type="text"
                placeholder={trans.__('Enter email address or username')}
                value={newUserEmail}
                onChange={(e) => setNewUserEmail(e.target.value)}
                disabled={isLoading}
                className="jp-PermissionsDialog-emailInput"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleInviteUser();
                  }
                }}
              />
            </div>

            <div className="jp-PermissionsDialog-inputGroup">
              <label htmlFor="inviteRole">{trans.__('Role:')}</label>
              <select
                id="inviteRole"
                value={defaultRole}
                onChange={(e) => setDefaultRole(e.target.value as CollaborativeRole)}
                disabled={isLoading}
                className="jp-PermissionsDialog-roleSelector"
              >
                <option value={CollaborativeRole.VIEWER}>
                  {getRoleLabel(CollaborativeRole.VIEWER)} - {getRoleDescription(CollaborativeRole.VIEWER)}
                </option>
                <option value={CollaborativeRole.EDITOR}>
                  {getRoleLabel(CollaborativeRole.EDITOR)} - {getRoleDescription(CollaborativeRole.EDITOR)}
                </option>
                <option value={CollaborativeRole.ADMIN}>
                  {getRoleLabel(CollaborativeRole.ADMIN)} - {getRoleDescription(CollaborativeRole.ADMIN)}
                </option>
              </select>
            </div>

            <button
              onClick={handleInviteUser}
              disabled={isLoading || !newUserEmail.trim()}
              className="jp-PermissionsDialog-inviteButton"
            >
              {isLoading ? trans.__('Inviting...') : trans.__('Send Invitation')}
            </button>
          </div>

          {pendingInvitations.length > 0 && (
            <div className="jp-PermissionsDialog-pendingInvitations">
              <h4>{trans.__('Pending Invitations')}</h4>
              <div className="jp-PermissionsDialog-invitationList">
                {pendingInvitations.map((invitation, index) => (
                  <div key={index} className="jp-PermissionsDialog-invitationRow">
                    <span>{invitation.email}</span>
                    <span className="jp-PermissionsDialog-invitationRole">
                      {getRoleLabel(invitation.role)}
                    </span>
                    <span className="jp-PermissionsDialog-invitationDate">
                      {invitation.timestamp.toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="jp-PermissionsDialog-accessDenied">
          <p>{trans.__('Only administrators can invite new users to this notebook.')}</p>
        </div>
      )}
    </div>
  );

  // Render settings tab
  const renderSettingsTab = () => (
    <div className="jp-PermissionsDialog-settingsSection">
      <div className="jp-PermissionsDialog-header">
        <h3>{trans.__('Permission Settings')}</h3>
        <p className="jp-PermissionsDialog-subtext">
          {trans.__('Configure default permissions and access control options')}
        </p>
      </div>

      {isCurrentUserAdmin ? (
        <>
          <div className="jp-PermissionsDialog-settingGroup">
            <label htmlFor="defaultRoleSetting">{trans.__('Default Role for New Users:')}</label>
            <select
              id="defaultRoleSetting"
              value={defaultRole}
              onChange={(e) => setDefaultRole(e.target.value as CollaborativeRole)}
              disabled={isLoading}
              className="jp-PermissionsDialog-roleSelector"
            >
              <option value={CollaborativeRole.VIEWER}>
                {getRoleLabel(CollaborativeRole.VIEWER)}
              </option>
              <option value={CollaborativeRole.EDITOR}>
                {getRoleLabel(CollaborativeRole.EDITOR)}
              </option>
            </select>
          </div>

          <div className="jp-PermissionsDialog-settingGroup">
            <label>
              <input
                type="checkbox"
                checked={guestAccessEnabled}
                onChange={(e) => setGuestAccessEnabled(e.target.checked)}
                disabled={isLoading}
              />
              {trans.__('Allow guest access (view-only for unauthenticated users)')}
            </label>
          </div>

          {auditLog.length > 0 && (
            <div className="jp-PermissionsDialog-auditSection">
              <h4>{trans.__('Recent Permission Changes')}</h4>
              <div className="jp-PermissionsDialog-auditLog">
                {auditLog.slice(-10).map((entry, index) => (
                  <div key={entry.id || index} className="jp-PermissionsDialog-auditEntry">
                    <span className="jp-PermissionsDialog-auditUser">{entry.userId}</span>
                    <span className="jp-PermissionsDialog-auditAction">{entry.action}</span>
                    <span className="jp-PermissionsDialog-auditPermission">{entry.permission}</span>
                    <span className="jp-PermissionsDialog-auditTime">
                      {entry.timestamp instanceof Date ? entry.timestamp.toLocaleString() : new Date(entry.timestamp).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="jp-PermissionsDialog-accessDenied">
          <p>{trans.__('Only administrators can modify permission settings.')}</p>
        </div>
      )}
    </div>
  );

  return (
    <div className="jp-PermissionsDialog">
      <div className="jp-PermissionsDialog-content">
        <div className="jp-PermissionsDialog-title">
          <h2>{trans.__('Manage Permissions')}</h2>
          <p className="jp-PermissionsDialog-subtitle">
            {trans.__(`Notebook: ${notebookPath}`)}
          </p>
        </div>

        {error && (
          <div className="jp-PermissionsDialog-error">
            <p>{error}</p>
          </div>
        )}

        <div className="jp-PermissionsDialog-tabs">
          <div className="jp-PermissionsDialog-tabHeaders">
            <button
              className={`jp-PermissionsDialog-tabHeader ${activeTab === 'users' ? 'active' : ''}`}
              onClick={() => setActiveTab('users')}
              disabled={isLoading}
            >
              {trans.__('Current Users')}
            </button>
            <button
              className={`jp-PermissionsDialog-tabHeader ${activeTab === 'invite' ? 'active' : ''}`}
              onClick={() => setActiveTab('invite')}
              disabled={isLoading}
            >
              {trans.__('Invite Users')}
            </button>
            <button
              className={`jp-PermissionsDialog-tabHeader ${activeTab === 'settings' ? 'active' : ''}`}
              onClick={() => setActiveTab('settings')}
              disabled={isLoading}
            >
              {trans.__('Settings')}
            </button>
          </div>

          <div className="jp-PermissionsDialog-tabContent">
            {isLoading && (
              <div className="jp-PermissionsDialog-loading">
                <p>{trans.__('Loading...')}</p>
              </div>
            )}

            {!isLoading && activeTab === 'users' && renderCurrentUsersTab()}
            {!isLoading && activeTab === 'invite' && renderInviteUsersTab()}
            {!isLoading && activeTab === 'settings' && renderSettingsTab()}
          </div>
        </div>

        <div className="jp-PermissionsDialog-actions">
          <button
            onClick={onClose}
            className="jp-PermissionsDialog-closeButton"
          >
            {trans.__('Close')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Permissions dialog management class with static methods for dialog operations
 */
export class permissionsDialog {
  /**
   * Create a new permissions dialog instance
   */
  static create(props: IPermissionsDialogProps): React.ReactElement {
    return React.createElement(PermissionsDialog, props);
  }

  /**
   * Show the permissions dialog in a modal
   */
  static showDialog(props: IPermissionsDialogProps): void {
    const element = document.createElement('div');
    element.className = 'jp-PermissionsDialog-modal';
    document.body.appendChild(element);

    const closeDialog = () => {
      if (element.parentNode) {
        element.parentNode.removeChild(element);
      }
      if (props.onClose) {
        props.onClose();
      }
    };

    const dialogProps = {
      ...props,
      onClose: closeDialog
    };

    const dialog = React.createElement(PermissionsDialog, dialogProps);
    const React = require('react');
    const ReactDOM = require('react-dom');
    ReactDOM.render(dialog, element);
  }

  /**
   * Manage permissions for the given notebook path
   */
  static managePermissions(
    permissionManager: PermissionManager,
    notebookPath: string,
    translator: ITranslator
  ): void {
    const props: IPermissionsDialogProps = {
      permissionManager,
      notebookPath,
      translator
    };

    this.showDialog(props);
  }

  /**
   * Invite users to collaborate on the notebook
   */
  static inviteUsers(
    permissionManager: PermissionManager,
    notebookPath: string,
    translator: ITranslator,
    defaultRole: CollaborativeRole = CollaborativeRole.EDITOR
  ): void {
    const props: IPermissionsDialogProps = {
      permissionManager,
      notebookPath,
      translator,
      onPermissionsUpdated: (permissions) => {
        console.log('Permissions updated:', permissions);
      }
    };

    this.showDialog(props);
  }
}

/**
 * Permissions dialog component utilities and factory methods
 */
export const PermissionsDialogComponent = {
  /**
   * Create a new permissions dialog component
   */
  create: (props: IPermissionsDialogProps): React.ReactElement => {
    return React.createElement(PermissionsDialog, props);
  },

  /**
   * Show dialog using component
   */
  showDialog: (props: IPermissionsDialogProps): void => {
    permissionsDialog.showDialog(props);
  },

  /**
   * Launch dialog compatible with JupyterLab dialog system
   */
  launch: (props: IPermissionsDialogProps): void => {
    permissionsDialog.showDialog(props);
  }
};
