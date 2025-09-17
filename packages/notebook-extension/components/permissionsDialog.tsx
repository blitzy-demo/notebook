/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * Permission management dialog component for configuring user access levels in collaborative sessions.
 * Provides UI for viewing current permissions, inviting new collaborators, changing roles (view-only, edit, admin),
 * and revoking access. Integrates with PermissionManager and JupyterHub authentication for comprehensive
 * role-based access control in real-time collaborative editing environments.
 */

import React, { useState, useEffect } from 'react';
import { Dialog } from '@jupyterlab/apputils';
import { ITranslator } from '@jupyterlab/translation';

import { PermissionManager } from '../../../notebook/src/collab/permissions';
import { CollaborativeRole } from '../../../notebook/src/tokens';

/**
 * Props interface for the PermissionsDialog component
 */
export interface IPermissionsDialogProps {
  /**
   * Permission manager instance for handling access control operations
   */
  permissionManager: PermissionManager;

  /**
   * Path to the notebook for which permissions are being managed
   */
  notebookPath: string;

  /**
   * Translation service for internationalization
   */
  translator: ITranslator;

  /**
   * Optional current user ID for permission checking
   */
  currentUserId?: string;
}

/**
 * Interface representing a permission change operation
 */
export interface IPermissionChange {
  /**
   * User ID whose permissions are being changed
   */
  userId: string;

  /**
   * Previous role before the change
   */
  previousRole: CollaborativeRole;

  /**
   * New role after the change
   */
  newRole: CollaborativeRole;

  /**
   * Timestamp when the change was made
   */
  timestamp: Date;

  /**
   * Whether the change is pending application
   */
  isPending: boolean;
}

/**
 * Interface representing a user in the permissions dialog
 */
interface IUserPermissionInfo {
  userId: string;
  username: string;
  displayName: string;
  role: CollaborativeRole;
  lastActivity: Date;
  isOnline: boolean;
}

/**
 * Interface representing a pending invitation
 */
interface IPendingInvitation {
  email: string;
  role: CollaborativeRole;
  timestamp: Date;
}

/**
 * Main PermissionsDialog React component
 */
export function PermissionsDialog({
  permissionManager,
  notebookPath,
  translator,
  currentUserId = 'current-user'
}: IPermissionsDialogProps): JSX.Element {
  const trans = translator.load('notebook');

  // State management
  const [activeTab, setActiveTab] = useState<'users' | 'invite' | 'settings'>('users');
  const [userList, setUserList] = useState<IUserPermissionInfo[]>([]);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [newUserEmail, setNewUserEmail] = useState<string>('');
  const [newUserRole, setNewUserRole] = useState<CollaborativeRole>(CollaborativeRole.VIEWER);
  const [pendingChanges, setPendingChanges] = useState<IPermissionChange[]>([]);
  const [pendingInvitations, setPendingInvitations] = useState<IPendingInvitation[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [currentUserRole, setCurrentUserRole] = useState<CollaborativeRole>(CollaborativeRole.VIEWER);
  const [auditLog, setAuditLog] = useState<any[]>([]);
  const [defaultRole, setDefaultRole] = useState<CollaborativeRole>(CollaborativeRole.VIEWER);
  const [guestAccess, setGuestAccess] = useState<boolean>(false);

  // Load current permissions and setup listeners on mount
  useEffect(() => {
    loadCurrentPermissions();
    loadAuditLog();

    // Setup permission change listener
    const handlePermissionChange = (change: { userId: string; newRole: CollaborativeRole; previousRole: CollaborativeRole }) => {
      setUserList(prevUsers =>
        prevUsers.map(user =>
          user.userId === change.userId
            ? { ...user, role: change.newRole }
            : user
        )
      );
    };

    permissionManager.onPermissionChange.connect(handlePermissionChange);

    return () => {
      permissionManager.onPermissionChange.disconnect(handlePermissionChange);
    };
  }, [permissionManager]);

  /**
   * Load current user permissions and roles
   */
  const loadCurrentPermissions = async (): Promise<void> => {
    setLoading(true);
    setError('');

    try {
      // Get current user's role for permission checking
      const userRole = await permissionManager.getUserRole(currentUserId);
      setCurrentUserRole(userRole);

      // Get cached permissions for all users
      const cachedPermissions = permissionManager.getCachedPermissions();

      // Convert to user list format
      const users: IUserPermissionInfo[] = [];
      for (const [userId, role] of cachedPermissions.entries()) {
        users.push({
          userId,
          username: userId, // In real implementation, would fetch from user service
          displayName: userId, // In real implementation, would fetch from user service
          role,
          lastActivity: new Date(), // In real implementation, would track actual activity
          isOnline: true // In real implementation, would check actual online status
        });
      }

      // Add current user if not in list
      if (!users.find(u => u.userId === currentUserId)) {
        users.push({
          userId: currentUserId,
          username: currentUserId,
          displayName: 'You',
          role: userRole,
          lastActivity: new Date(),
          isOnline: true
        });
      }

      setUserList(users);
    } catch (err) {
      setError(trans.__('Failed to load current permissions: %1').format(String(err)));
      console.error('Error loading permissions:', err);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Load audit log for compliance tracking
   */
  const loadAuditLog = async (): Promise<void> => {
    try {
      const log = await permissionManager.auditLog();
      setAuditLog(log);
    } catch (err) {
      console.error('Error loading audit log:', err);
    }
  };

  /**
   * Handle role change for existing user
   */
  const handleRoleChange = async (userId: string, newRole: CollaborativeRole): Promise<void> => {
    // Check if current user can make this change
    const canManage = await permissionManager.checkPermission(currentUserId, 'manage');
    if (!canManage) {
      setError(trans.__('You do not have permission to change user roles'));
      return;
    }

    const user = userList.find(u => u.userId === userId);
    if (!user) {
      setError(trans.__('User not found'));
      return;
    }

    // Add to pending changes
    const change: IPermissionChange = {
      userId,
      previousRole: user.role,
      newRole,
      timestamp: new Date(),
      isPending: true
    };

    setPendingChanges(prev => [...prev, change]);

    // Update UI optimistically
    setUserList(prev =>
      prev.map(u => u.userId === userId ? { ...u, role: newRole } : u)
    );
  };

  /**
   * Apply all pending permission changes
   */
  const applyPermissionChanges = async (): Promise<void> => {
    if (pendingChanges.length === 0) return;

    setLoading(true);
    setError('');

    try {
      // Build permissions update object
      const permissionsUpdate: Record<string, CollaborativeRole> = {};
      pendingChanges.forEach(change => {
        permissionsUpdate[change.userId] = change.newRole;
      });

      // Apply changes via permission manager
      await permissionManager.updatePermissions(permissionsUpdate);

      // Clear pending changes
      setPendingChanges([]);

      // Reload to ensure consistency
      await loadCurrentPermissions();
      await loadAuditLog();
    } catch (err) {
      setError(trans.__('Failed to apply permission changes: %1').format(String(err)));
      console.error('Error applying permission changes:', err);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Remove user from collaboration (revoke all permissions)
   */
  const handleRemoveUser = async (userId: string): Promise<void> => {
    // Show confirmation dialog
    const result = await Dialog.launch({
      title: trans.__('Remove User'),
      body: trans.__('Are you sure you want to remove this user from the collaboration? This action cannot be undone.'),
      buttons: [
        Dialog.cancelButton({ label: trans.__('Cancel') }),
        Dialog.warnButton({ label: trans.__('Remove') })
      ]
    });

    if (!result.button.accept) {
      return;
    }

    setLoading(true);
    setError('');

    try {
      await permissionManager.revokePermission(userId);
      setUserList(prev => prev.filter(u => u.userId !== userId));
      await loadAuditLog();
    } catch (err) {
      setError(trans.__('Failed to remove user: %1').format(String(err)));
      console.error('Error removing user:', err);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Send invitation to new user
   */
  const handleInviteUser = async (): Promise<void> => {
    if (!newUserEmail.trim()) {
      setError(trans.__('Please enter a valid email address'));
      return;
    }

    // Check if current user can invite
    const canManage = await permissionManager.checkPermission(currentUserId, 'manage');
    if (!canManage) {
      setError(trans.__('You do not have permission to invite users'));
      return;
    }

    setLoading(true);
    setError('');

    try {
      // In a real implementation, this would send an invitation email
      // For now, we'll simulate by adding to pending invitations
      const invitation: IPendingInvitation = {
        email: newUserEmail,
        role: newUserRole,
        timestamp: new Date()
      };

      setPendingInvitations(prev => [...prev, invitation]);

      // Clear form
      setNewUserEmail('');
      setNewUserRole(CollaborativeRole.VIEWER);

      // In a real implementation, would also create the user with specified role
      await permissionManager.setPermission(newUserEmail, 'collaborate', true);
      await permissionManager.updatePermissions({ [newUserEmail]: newUserRole });

      await loadCurrentPermissions();
    } catch (err) {
      setError(trans.__('Failed to invite user: %1').format(String(err)));
      console.error('Error inviting user:', err);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Sync with JupyterHub authentication system
   */
  const handleSyncWithJupyterHub = async (): Promise<void> => {
    setLoading(true);
    setError('');

    try {
      await permissionManager.syncWithJupyterHub();
      await loadCurrentPermissions();
      await loadAuditLog();
    } catch (err) {
      setError(trans.__('Failed to sync with JupyterHub: %1').format(String(err)));
      console.error('Error syncing with JupyterHub:', err);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Get role display name for UI
   */
  const getRoleDisplayName = (role: CollaborativeRole): string => {
    switch (role) {
      case CollaborativeRole.ADMIN:
        return trans.__('Admin');
      case CollaborativeRole.EDITOR:
        return trans.__('Editor');
      case CollaborativeRole.VIEWER:
        return trans.__('Viewer');
      default:
        return role;
    }
  };

  /**
   * Check if current user can modify permissions
   */
  const canModifyPermissions = currentUserRole === CollaborativeRole.ADMIN;

  return (
    <div className="jp-PermissionsDialog">
      {/* Header */}
      <div className="jp-PermissionsDialog-header">
        <h2>{trans.__('Manage Permissions')}</h2>
        <p>{trans.__('Notebook: %1').format(notebookPath)}</p>
        {error && (
          <div className="jp-PermissionsDialog-error" role="alert">
            {error}
          </div>
        )}
      </div>

      {/* Tab Navigation */}
      <div className="jp-PermissionsDialog-tabs">
        <button
          className={`jp-PermissionsDialog-tab ${activeTab === 'users' ? 'active' : ''}`}
          onClick={() => setActiveTab('users')}
        >
          {trans.__('Current Users')}
        </button>
        <button
          className={`jp-PermissionsDialog-tab ${activeTab === 'invite' ? 'active' : ''}`}
          onClick={() => setActiveTab('invite')}
          disabled={!canModifyPermissions}
        >
          {trans.__('Invite Users')}
        </button>
        <button
          className={`jp-PermissionsDialog-tab ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
          disabled={!canModifyPermissions}
        >
          {trans.__('Settings')}
        </button>
      </div>

      {/* Tab Content */}
      <div className="jp-PermissionsDialog-content">
        {activeTab === 'users' && (
          <div className="jp-PermissionsDialog-usersTab">
            <div className="jp-PermissionsDialog-userList">
              {loading && <div>{trans.__('Loading...')}</div>}

              {userList.map(user => (
                <div key={user.userId} className="jp-PermissionsDialog-userRow">
                  <div className="jp-PermissionsDialog-userInfo">
                    <div className="jp-PermissionsDialog-userAvatar">
                      {user.displayName.charAt(0).toUpperCase()}
                    </div>
                    <div className="jp-PermissionsDialog-userDetails">
                      <div className="jp-PermissionsDialog-userName">
                        {user.displayName}
                        {user.userId === currentUserId && ` (${trans.__('You')})`}
                      </div>
                      <div className="jp-PermissionsDialog-userStatus">
                        <span className={`jp-PermissionsDialog-onlineStatus ${user.isOnline ? 'online' : 'offline'}`}>
                          {user.isOnline ? trans.__('Online') : trans.__('Offline')}
                        </span>
                        <span className="jp-PermissionsDialog-lastActivity">
                          {trans.__('Last active: %1').format(user.lastActivity.toLocaleString())}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="jp-PermissionsDialog-userActions">
                    <select
                      className="jp-PermissionsDialog-roleSelector"
                      value={user.role}
                      onChange={(e) => handleRoleChange(user.userId, e.target.value as CollaborativeRole)}
                      disabled={!canModifyPermissions || user.userId === currentUserId}
                    >
                      <option value={CollaborativeRole.VIEWER}>
                        {getRoleDisplayName(CollaborativeRole.VIEWER)}
                      </option>
                      <option value={CollaborativeRole.EDITOR}>
                        {getRoleDisplayName(CollaborativeRole.EDITOR)}
                      </option>
                      <option value={CollaborativeRole.ADMIN}>
                        {getRoleDisplayName(CollaborativeRole.ADMIN)}
                      </option>
                    </select>

                    {canModifyPermissions && user.userId !== currentUserId && (
                      <button
                        className="jp-PermissionsDialog-removeButton"
                        onClick={() => handleRemoveUser(user.userId)}
                        title={trans.__('Remove user from collaboration')}
                      >
                        {trans.__('Remove')}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {pendingChanges.length > 0 && (
              <div className="jp-PermissionsDialog-pendingChanges">
                <h3>{trans.__('Pending Changes')}</h3>
                {pendingChanges.map((change, index) => (
                  <div key={index} className="jp-PermissionsDialog-pendingChange">
                    {trans.__('%1: %2 → %3').format(
                      change.userId,
                      getRoleDisplayName(change.previousRole),
                      getRoleDisplayName(change.newRole)
                    )}
                  </div>
                ))}
                <button
                  className="jp-PermissionsDialog-applyButton"
                  onClick={applyPermissionChanges}
                  disabled={loading}
                >
                  {trans.__('Apply Changes')}
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'invite' && canModifyPermissions && (
          <div className="jp-PermissionsDialog-inviteTab">
            <div className="jp-PermissionsDialog-inviteForm">
              <h3>{trans.__('Invite New User')}</h3>

              <div className="jp-PermissionsDialog-formGroup">
                <label htmlFor="newUserEmail">
                  {trans.__('Email Address')}
                </label>
                <input
                  id="newUserEmail"
                  type="email"
                  value={newUserEmail}
                  onChange={(e) => setNewUserEmail(e.target.value)}
                  placeholder={trans.__('Enter email address')}
                />
              </div>

              <div className="jp-PermissionsDialog-formGroup">
                <label htmlFor="newUserRole">
                  {trans.__('Role')}
                </label>
                <select
                  id="newUserRole"
                  value={newUserRole}
                  onChange={(e) => setNewUserRole(e.target.value as CollaborativeRole)}
                >
                  <option value={CollaborativeRole.VIEWER}>
                    {getRoleDisplayName(CollaborativeRole.VIEWER)}
                  </option>
                  <option value={CollaborativeRole.EDITOR}>
                    {getRoleDisplayName(CollaborativeRole.EDITOR)}
                  </option>
                  <option value={CollaborativeRole.ADMIN}>
                    {getRoleDisplayName(CollaborativeRole.ADMIN)}
                  </option>
                </select>
              </div>

              <button
                className="jp-PermissionsDialog-inviteButton"
                onClick={handleInviteUser}
                disabled={loading || !newUserEmail.trim()}
              >
                {trans.__('Send Invitation')}
              </button>
            </div>

            {pendingInvitations.length > 0 && (
              <div className="jp-PermissionsDialog-pendingInvitations">
                <h3>{trans.__('Pending Invitations')}</h3>
                {pendingInvitations.map((invitation, index) => (
                  <div key={index} className="jp-PermissionsDialog-pendingInvitation">
                    <span>{invitation.email}</span>
                    <span className="jp-PermissionsDialog-invitationRole">
                      {getRoleDisplayName(invitation.role)}
                    </span>
                    <span className="jp-PermissionsDialog-invitationDate">
                      {invitation.timestamp.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'settings' && canModifyPermissions && (
          <div className="jp-PermissionsDialog-settingsTab">
            <h3>{trans.__('Permission Settings')}</h3>

            <div className="jp-PermissionsDialog-setting">
              <label htmlFor="defaultRole">
                {trans.__('Default role for new users')}
              </label>
              <select
                id="defaultRole"
                value={defaultRole}
                onChange={(e) => setDefaultRole(e.target.value as CollaborativeRole)}
              >
                <option value={CollaborativeRole.VIEWER}>
                  {getRoleDisplayName(CollaborativeRole.VIEWER)}
                </option>
                <option value={CollaborativeRole.EDITOR}>
                  {getRoleDisplayName(CollaborativeRole.EDITOR)}
                </option>
              </select>
            </div>

            <div className="jp-PermissionsDialog-setting">
              <label>
                <input
                  type="checkbox"
                  checked={guestAccess}
                  onChange={(e) => setGuestAccess(e.target.checked)}
                />
                {trans.__('Allow guest access (view-only)')}
              </label>
            </div>

            <div className="jp-PermissionsDialog-actions">
              <button
                onClick={handleSyncWithJupyterHub}
                disabled={loading}
              >
                {trans.__('Sync with JupyterHub')}
              </button>
            </div>

            {auditLog.length > 0 && (
              <div className="jp-PermissionsDialog-auditLog">
                <h4>{trans.__('Recent Activity')}</h4>
                <div className="jp-PermissionsDialog-auditEntries">
                  {auditLog.slice(0, 10).map((entry, index) => (
                    <div key={index} className="jp-PermissionsDialog-auditEntry">
                      <span className="jp-PermissionsDialog-auditUser">
                        {entry.userId}
                      </span>
                      <span className="jp-PermissionsDialog-auditAction">
                        {entry.action}
                      </span>
                      <span className="jp-PermissionsDialog-auditPermission">
                        {entry.permission}
                      </span>
                      <span className="jp-PermissionsDialog-auditTime">
                        {new Date(entry.timestamp).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Namespace for PermissionsDialogComponent static methods
 */
export namespace PermissionsDialogComponent {
  /**
   * Create a new PermissionsDialog widget
   */
  export const create = (props: IPermissionsDialogProps): Dialog<any> => {
    const body = <PermissionsDialog {...props} />;

    return new Dialog({
      title: props.translator.load('notebook').__('Manage Permissions'),
      body,
      buttons: [
        Dialog.cancelButton({ label: props.translator.load('notebook').__('Close') })
      ],
      defaultButton: 0,
      focusNodeSelector: '.jp-PermissionsDialog-userList'
    });
  };

  /**
   * Launch the permissions dialog
   */
  export const launch = async (props: IPermissionsDialogProps): Promise<Dialog.IResult<any>> => {
    const dialog = create(props);
    return dialog.launch();
  };
}
