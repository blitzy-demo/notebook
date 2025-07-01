// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { ReactWidget, Dialog, showDialog } from '@jupyterlab/apputils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { ICollaborationPermissions, ICollaborationService } from '@jupyter-notebook/application';
import React, { useState, useEffect, useCallback, useMemo } from 'react';

/**
 * User role types for collaboration permissions
 */
export type UserRole = 'view' | 'edit' | 'admin';

/**
 * User information interface
 */
export interface IUser {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  role: UserRole;
  avatarUrl?: string;
  isActive: boolean;
  lastActive?: Date;
}

/**
 * Permission operation types
 */
export type PermissionOperation = 
  | 'view_notebook' 
  | 'edit_cell'
  | 'execute_cell'
  | 'add_comment'
  | 'resolve_comment'
  | 'manage_users'
  | 'manage_permissions'
  | 'delete_notebook';

/**
 * Permission validation result interface
 */
export interface IPermissionValidation {
  isValid: boolean;
  reason?: string;
  suggestedRole?: UserRole;
}

/**
 * Props for the PermissionDialog component
 */
interface IPermissionDialogProps {
  permissions: ICollaborationPermissions;
  collaborationService: ICollaborationService;
  translator: ITranslator;
  onClose?: () => void;
}

/**
 * Props for the PermissionDialog body component
 */
interface IPermissionDialogBodyProps extends IPermissionDialogProps {
  onValidationChange: (isValid: boolean) => void;
}

/**
 * User search and filter interface
 */
interface IUserFilter {
  searchTerm: string;
  roleFilter: UserRole | 'all';
  statusFilter: 'all' | 'active' | 'inactive';
  sortBy: 'name' | 'role' | 'lastActive';
  sortOrder: 'asc' | 'desc';
}

/**
 * React component for the permission dialog body
 */
const PermissionDialogBody: React.FC<IPermissionDialogBodyProps> = ({
  permissions,
  collaborationService,
  translator,
  onValidationChange,
}) => {
  const trans = translator.load('notebook');
  
  // State management
  const [users, setUsers] = useState<IUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [bulkRole, setBulkRole] = useState<UserRole>('view');
  const [validationErrors, setValidationErrors] = useState<Map<string, string>>(new Map());
  const [saveInProgress, setSaveInProgress] = useState(false);
  
  // User filtering and search state
  const [filter, setFilter] = useState<IUserFilter>({
    searchTerm: '',
    roleFilter: 'all',
    statusFilter: 'all',
    sortBy: 'name',
    sortOrder: 'asc',
  });

  // Current user information
  const currentUser = permissions.getCurrentUser();
  const currentUserRole = permissions.getUserRole();
  const canManagePermissions = permissions.hasPermission('manage_permissions');

  /**
   * Load users from the collaboration service
   */
  const loadUsers = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      // Get session participants and directory users
      const session = collaborationService.getCurrentSession();
      const sessionUsers = session ? await collaborationService.getSessionUsers() : [];
      
      // Get additional users from directory (JupyterHub integration)
      const directoryUsers = await permissions.searchUsers('', { limit: 100 });
      
      // Merge and deduplicate users
      const userMap = new Map<string, IUser>();
      
      // Add session users first (they're currently active)
      sessionUsers.forEach(user => {
        userMap.set(user.id, {
          ...user,
          isActive: true,
          role: permissions.getUserRole(user.id),
        });
      });
      
      // Add directory users
      directoryUsers.forEach(user => {
        if (!userMap.has(user.id)) {
          userMap.set(user.id, {
            ...user,
            isActive: false,
            role: permissions.getUserRole(user.id),
          });
        }
      });
      
      setUsers(Array.from(userMap.values()));
    } catch (err) {
      console.error('Failed to load users:', err);
      setError(trans.__('Failed to load users. Please try again.'));
    } finally {
      setLoading(false);
    }
  }, [permissions, collaborationService, trans]);

  /**
   * Filter and sort users based on current filter settings
   */
  const filteredUsers = useMemo(() => {
    let filtered = users.filter(user => {
      // Search term filter
      if (filter.searchTerm) {
        const searchLower = filter.searchTerm.toLowerCase();
        const matchesSearch = 
          user.username.toLowerCase().includes(searchLower) ||
          user.displayName.toLowerCase().includes(searchLower) ||
          (user.email && user.email.toLowerCase().includes(searchLower));
        if (!matchesSearch) return false;
      }
      
      // Role filter
      if (filter.roleFilter !== 'all' && user.role !== filter.roleFilter) {
        return false;
      }
      
      // Status filter
      if (filter.statusFilter === 'active' && !user.isActive) return false;
      if (filter.statusFilter === 'inactive' && user.isActive) return false;
      
      return true;
    });
    
    // Sort users
    filtered.sort((a, b) => {
      let comparison = 0;
      
      switch (filter.sortBy) {
        case 'name':
          comparison = a.displayName.localeCompare(b.displayName);
          break;
        case 'role':
          const roleOrder = { 'admin': 3, 'edit': 2, 'view': 1 };
          comparison = roleOrder[a.role] - roleOrder[b.role];
          break;
        case 'lastActive':
          const aTime = a.lastActive?.getTime() || 0;
          const bTime = b.lastActive?.getTime() || 0;
          comparison = aTime - bTime;
          break;
      }
      
      return filter.sortOrder === 'desc' ? -comparison : comparison;
    });
    
    return filtered;
  }, [users, filter]);

  /**
   * Validate role assignment for a user
   */
  const validateRoleAssignment = useCallback(async (
    userId: string, 
    newRole: UserRole
  ): Promise<IPermissionValidation> => {
    try {
      // Check if current user has permission to assign this role
      if (!canManagePermissions) {
        return {
          isValid: false,
          reason: trans.__('You do not have permission to manage user roles'),
        };
      }
      
      // Prevent users from demoting themselves unless there are other admins
      if (userId === currentUser.id && newRole !== 'admin') {
        const adminCount = users.filter(u => u.role === 'admin').length;
        if (adminCount <= 1) {
          return {
            isValid: false,
            reason: trans.__('Cannot remove the last admin user'),
            suggestedRole: 'admin',
          };
        }
      }
      
      // Check JupyterHub token permissions for this role
      const hasTokenPermission = await permissions.validateTokenPermission(newRole);
      if (!hasTokenPermission) {
        return {
          isValid: false,
          reason: trans.__('JupyterHub token does not allow assigning this role'),
        };
      }
      
      // Enterprise-specific validation (if applicable)
      const enterpriseValidation = await permissions.validateEnterpriseRoleAssignment(userId, newRole);
      if (!enterpriseValidation.isValid) {
        return enterpriseValidation;
      }
      
      return { isValid: true };
    } catch (err) {
      console.error('Role validation failed:', err);
      return {
        isValid: false,
        reason: trans.__('Validation failed. Please try again.'),
      };
    }
  }, [canManagePermissions, currentUser.id, users, permissions, trans]);

  /**
   * Handle individual user role change
   */
  const handleUserRoleChange = useCallback(async (userId: string, newRole: UserRole) => {
    const validation = await validateRoleAssignment(userId, newRole);
    
    if (!validation.isValid) {
      setValidationErrors(prev => new Map(prev).set(userId, validation.reason || ''));
      return;
    }
    
    // Clear any existing validation error
    setValidationErrors(prev => {
      const newErrors = new Map(prev);
      newErrors.delete(userId);
      return newErrors;
    });
    
    // Update user role locally (optimistic update)
    setUsers(prev => prev.map(user => 
      user.id === userId ? { ...user, role: newRole } : user
    ));
    
    try {
      await permissions.setUserRole(userId, newRole);
    } catch (err) {
      console.error('Failed to update user role:', err);
      // Revert optimistic update
      setUsers(prev => prev.map(user => 
        user.id === userId ? { ...user, role: permissions.getUserRole(userId) } : user
      ));
      setValidationErrors(prev => new Map(prev).set(userId, trans.__('Failed to update role')));
    }
  }, [validateRoleAssignment, permissions, trans]);

  /**
   * Handle bulk role assignment
   */
  const handleBulkRoleAssignment = useCallback(async () => {
    if (selectedUsers.size === 0) return;
    
    setSaveInProgress(true);
    const errors: string[] = [];
    
    try {
      for (const userId of selectedUsers) {
        const validation = await validateRoleAssignment(userId, bulkRole);
        if (!validation.isValid) {
          errors.push(`${users.find(u => u.id === userId)?.displayName}: ${validation.reason}`);
          continue;
        }
        
        try {
          await permissions.setUserRole(userId, bulkRole);
          // Update local state
          setUsers(prev => prev.map(user => 
            user.id === userId ? { ...user, role: bulkRole } : user
          ));
        } catch (err) {
          errors.push(`${users.find(u => u.id === userId)?.displayName}: Failed to update`);
        }
      }
      
      if (errors.length === 0) {
        setSelectedUsers(new Set());
      } else {
        setError(trans.__('Some role assignments failed:\n%1', errors.join('\n')));
      }
    } finally {
      setSaveInProgress(false);
    }
  }, [selectedUsers, bulkRole, validateRoleAssignment, permissions, users, trans]);

  /**
   * Remove user from collaboration
   */
  const handleRemoveUser = useCallback(async (userId: string) => {
    if (!permissions.hasPermission('manage_users')) return;
    
    try {
      await permissions.removeUserFromCollaboration(userId);
      setUsers(prev => prev.filter(user => user.id !== userId));
    } catch (err) {
      console.error('Failed to remove user:', err);
      setError(trans.__('Failed to remove user from collaboration'));
    }
  }, [permissions, trans]);

  /**
   * Add new user to collaboration
   */
  const handleAddUser = useCallback(async (userEmail: string, role: UserRole = 'view') => {
    try {
      const user = await permissions.inviteUserByEmail(userEmail, role);
      setUsers(prev => [...prev, user]);
    } catch (err) {
      console.error('Failed to add user:', err);
      setError(trans.__('Failed to invite user. Please check the email address.'));
    }
  }, [permissions, trans]);

  // Load users on component mount
  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  // Update validation state
  useEffect(() => {
    const hasErrors = validationErrors.size > 0 || !!error;
    onValidationChange(!hasErrors && !loading);
  }, [validationErrors, error, loading, onValidationChange]);

  // Render role badge
  const renderRoleBadge = useCallback((role: UserRole) => {
    const roleColors = {
      admin: 'jp-PermissionDialog-roleBadge-admin',
      edit: 'jp-PermissionDialog-roleBadge-edit',
      view: 'jp-PermissionDialog-roleBadge-view',
    };
    
    const roleLabels = {
      admin: trans.__('Admin'),
      edit: trans.__('Editor'),
      view: trans.__('Viewer'),
    };
    
    return (
      <span className={`jp-PermissionDialog-roleBadge ${roleColors[role]}`}>
        {roleLabels[role]}
      </span>
    );
  }, [trans]);

  // Render user avatar
  const renderUserAvatar = useCallback((user: IUser) => {
    if (user.avatarUrl) {
      return (
        <img 
          src={user.avatarUrl} 
          alt={user.displayName}
          className="jp-PermissionDialog-avatar"
        />
      );
    }
    
    // Generate initials from display name
    const initials = user.displayName
      .split(' ')
      .map(name => name.charAt(0).toUpperCase())
      .slice(0, 2)
      .join('');
    
    return (
      <div className="jp-PermissionDialog-avatar jp-PermissionDialog-avatar-initials">
        {initials}
      </div>
    );
  }, []);

  if (loading) {
    return (
      <div className="jp-PermissionDialog-loading">
        <div className="jp-SpinnerContent">
          <div className="jp-Spinner">
            <div className="jp-SpinnerContent-bounce1"></div>
            <div className="jp-SpinnerContent-bounce2"></div>
            <div className="jp-SpinnerContent-bounce3"></div>
          </div>
        </div>
        <p>{trans.__('Loading users...')}</p>
      </div>
    );
  }

  return (
    <div className="jp-PermissionDialog-content">
      {/* Header with current user info and collaboration status */}
      <div className="jp-PermissionDialog-header">
        <div className="jp-PermissionDialog-currentUser">
          {renderUserAvatar(currentUser)}
          <div className="jp-PermissionDialog-currentUserInfo">
            <div className="jp-PermissionDialog-currentUserName">
              {currentUser.displayName}
            </div>
            <div className="jp-PermissionDialog-currentUserRole">
              {renderRoleBadge(currentUserRole)}
            </div>
          </div>
        </div>
        
        <div className="jp-PermissionDialog-status">
          <div className="jp-PermissionDialog-statusItem">
            <span className="jp-PermissionDialog-statusLabel">
              {trans.__('Total Users:')}
            </span>
            <span className="jp-PermissionDialog-statusValue">
              {users.length}
            </span>
          </div>
          <div className="jp-PermissionDialog-statusItem">
            <span className="jp-PermissionDialog-statusLabel">
              {trans.__('Active:')}
            </span>
            <span className="jp-PermissionDialog-statusValue">
              {users.filter(u => u.isActive).length}
            </span>
          </div>
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="jp-PermissionDialog-error">
          <div className="jp-PermissionDialog-errorIcon">⚠️</div>
          <div className="jp-PermissionDialog-errorMessage">{error}</div>
          <button 
            className="jp-PermissionDialog-errorClose"
            onClick={() => setError(null)}
          >
            ×
          </button>
        </div>
      )}

      {/* Search and filter controls */}
      <div className="jp-PermissionDialog-controls">
        <div className="jp-PermissionDialog-searchRow">
          <input
            type="text"
            className="jp-PermissionDialog-searchInput"
            placeholder={trans.__('Search users by name or email...')}
            value={filter.searchTerm}
            onChange={(e) => setFilter(prev => ({ ...prev, searchTerm: e.target.value }))}
          />
          
          <select
            className="jp-PermissionDialog-filterSelect"
            value={filter.roleFilter}
            onChange={(e) => setFilter(prev => ({ ...prev, roleFilter: e.target.value as UserRole | 'all' }))}
          >
            <option value="all">{trans.__('All Roles')}</option>
            <option value="admin">{trans.__('Admin')}</option>
            <option value="edit">{trans.__('Editor')}</option>
            <option value="view">{trans.__('Viewer')}</option>
          </select>
          
          <select
            className="jp-PermissionDialog-filterSelect"
            value={filter.statusFilter}
            onChange={(e) => setFilter(prev => ({ ...prev, statusFilter: e.target.value as 'all' | 'active' | 'inactive' }))}
          >
            <option value="all">{trans.__('All Status')}</option>
            <option value="active">{trans.__('Active')}</option>
            <option value="inactive">{trans.__('Inactive')}</option>
          </select>
        </div>
        
        {/* Bulk actions */}
        {canManagePermissions && selectedUsers.size > 0 && (
          <div className="jp-PermissionDialog-bulkActions">
            <span className="jp-PermissionDialog-bulkLabel">
              {trans._n('1 user selected', '%1 users selected', selectedUsers.size, selectedUsers.size)}
            </span>
            
            <select
              className="jp-PermissionDialog-bulkRoleSelect"
              value={bulkRole}
              onChange={(e) => setBulkRole(e.target.value as UserRole)}
            >
              <option value="view">{trans.__('Set as Viewer')}</option>
              <option value="edit">{trans.__('Set as Editor')}</option>
              <option value="admin">{trans.__('Set as Admin')}</option>
            </select>
            
            <button
              className="jp-PermissionDialog-bulkApply"
              onClick={handleBulkRoleAssignment}
              disabled={saveInProgress}
            >
              {saveInProgress ? trans.__('Applying...') : trans.__('Apply')}
            </button>
            
            <button
              className="jp-PermissionDialog-bulkClear"
              onClick={() => setSelectedUsers(new Set())}
            >
              {trans.__('Clear Selection')}
            </button>
          </div>
        )}
      </div>

      {/* User list */}
      <div className="jp-PermissionDialog-userList">
        {filteredUsers.length === 0 ? (
          <div className="jp-PermissionDialog-emptyState">
            <div className="jp-PermissionDialog-emptyIcon">👥</div>
            <div className="jp-PermissionDialog-emptyMessage">
              {filter.searchTerm || filter.roleFilter !== 'all' || filter.statusFilter !== 'all'
                ? trans.__('No users match the current filters')
                : trans.__('No users found')
              }
            </div>
          </div>
        ) : (
          filteredUsers.map((user) => (
            <div 
              key={user.id} 
              className={`jp-PermissionDialog-userItem ${user.isActive ? 'jp-PermissionDialog-userItem-active' : ''}`}
            >
              {canManagePermissions && user.id !== currentUser.id && (
                <input
                  type="checkbox"
                  className="jp-PermissionDialog-userCheckbox"
                  checked={selectedUsers.has(user.id)}
                  onChange={(e) => {
                    const newSelection = new Set(selectedUsers);
                    if (e.target.checked) {
                      newSelection.add(user.id);
                    } else {
                      newSelection.delete(user.id);
                    }
                    setSelectedUsers(newSelection);
                  }}
                />
              )}
              
              <div className="jp-PermissionDialog-userInfo">
                {renderUserAvatar(user)}
                <div className="jp-PermissionDialog-userDetails">
                  <div className="jp-PermissionDialog-userName">
                    {user.displayName}
                    {user.id === currentUser.id && (
                      <span className="jp-PermissionDialog-youLabel">
                        {trans.__('(You)')}
                      </span>
                    )}
                    {user.isActive && (
                      <span className="jp-PermissionDialog-activeIndicator">
                        {trans.__('Online')}
                      </span>
                    )}
                  </div>
                  <div className="jp-PermissionDialog-userMeta">
                    <span className="jp-PermissionDialog-username">
                      @{user.username}
                    </span>
                    {user.email && (
                      <span className="jp-PermissionDialog-email">
                        {user.email}
                      </span>
                    )}
                    {user.lastActive && !user.isActive && (
                      <span className="jp-PermissionDialog-lastActive">
                        {trans.__('Last active: %1', user.lastActive.toLocaleDateString())}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              
              <div className="jp-PermissionDialog-userActions">
                {canManagePermissions && user.id !== currentUser.id ? (
                  <select
                    className="jp-PermissionDialog-roleSelect"
                    value={user.role}
                    onChange={(e) => handleUserRoleChange(user.id, e.target.value as UserRole)}
                  >
                    <option value="view">{trans.__('Viewer')}</option>
                    <option value="edit">{trans.__('Editor')}</option>
                    <option value="admin">{trans.__('Admin')}</option>
                  </select>
                ) : (
                  renderRoleBadge(user.role)
                )}
                
                {canManagePermissions && user.id !== currentUser.id && (
                  <button
                    className="jp-PermissionDialog-removeUser"
                    onClick={() => handleRemoveUser(user.id)}
                    title={trans.__('Remove user from collaboration')}
                  >
                    ×
                  </button>
                )}
              </div>
              
              {validationErrors.has(user.id) && (
                <div className="jp-PermissionDialog-userError">
                  {validationErrors.get(user.id)}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Add user section */}
      {canManagePermissions && (
        <div className="jp-PermissionDialog-addUser">
          <details className="jp-PermissionDialog-addUserDetails">
            <summary className="jp-PermissionDialog-addUserSummary">
              {trans.__('Invite New User')}
            </summary>
            <div className="jp-PermissionDialog-addUserForm">
              <input
                type="email"
                className="jp-PermissionDialog-addUserInput"
                placeholder={trans.__('Enter email address...')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const email = (e.target as HTMLInputElement).value.trim();
                    if (email) {
                      handleAddUser(email);
                      (e.target as HTMLInputElement).value = '';
                    }
                  }
                }}
              />
              <select className="jp-PermissionDialog-addUserRole">
                <option value="view">{trans.__('Viewer')}</option>
                <option value="edit">{trans.__('Editor')}</option>
                <option value="admin">{trans.__('Admin')}</option>
              </select>
              <button 
                className="jp-PermissionDialog-addUserButton"
                onClick={() => {
                  const input = document.querySelector('.jp-PermissionDialog-addUserInput') as HTMLInputElement;
                  const select = document.querySelector('.jp-PermissionDialog-addUserRole') as HTMLSelectElement;
                  const email = input.value.trim();
                  if (email) {
                    handleAddUser(email, select.value as UserRole);
                    input.value = '';
                  }
                }}
              >
                {trans.__('Invite')}
              </button>
            </div>
          </details>
        </div>
      )}
    </div>
  );
};

/**
 * React component for the complete permission dialog
 */
const PermissionDialogComponent: React.FC<IPermissionDialogProps> = (props) => {
  const [isValid, setIsValid] = useState(false);
  
  return (
    <div className="jp-PermissionDialog">
      <PermissionDialogBody 
        {...props} 
        onValidationChange={setIsValid}
      />
    </div>
  );
};

/**
 * Permission Dialog namespace with static methods
 */
export namespace PermissionDialog {
  /**
   * Options for showing the permission dialog
   */
  export interface IShowDialogOptions {
    permissions: ICollaborationPermissions;
    collaborationService: ICollaborationService;
    translator?: ITranslator;
  }

  /**
   * Show the permission dialog
   */
  export async function showDialog(options: IShowDialogOptions): Promise<Dialog.IResult<void>> {
    const { permissions, collaborationService, translator = nullTranslator } = options;
    const trans = translator.load('notebook');
    
    // Check if user has permission to manage permissions
    if (!permissions.hasPermission('manage_permissions')) {
      return showDialog({
        title: trans.__('Access Denied'),
        body: trans.__('You do not have permission to manage collaboration permissions.'),
        buttons: [Dialog.okButton({ label: trans.__('OK') })],
      });
    }
    
    const dialog = new Dialog({
      title: trans.__('Manage Collaboration Permissions'),
      body: ReactWidget.create(
        <PermissionDialogComponent
          permissions={permissions}
          collaborationService={collaborationService}
          translator={translator}
        />
      ),
      buttons: [
        Dialog.cancelButton({ label: trans.__('Close') }),
      ],
      focusNodeSelector: '.jp-PermissionDialog-searchInput',
      hasClose: true,
    });
    
    return dialog.launch();
  }

  /**
   * Create a permission dialog widget (for use in sidebars or panels)
   */
  export function create(options: IShowDialogOptions): ReactWidget {
    return ReactWidget.create(
      <PermissionDialogComponent
        permissions={options.permissions}
        collaborationService={options.collaborationService}
        translator={options.translator || nullTranslator}
      />
    );
  }
}