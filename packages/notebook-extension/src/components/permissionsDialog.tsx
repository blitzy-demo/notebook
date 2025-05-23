// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Dialog, showDialog } from '@jupyterlab/apputils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { IPermissionsService } from '@jupyter-notebook/application';
import { UserRole, PermissionLevel, ROLE_PERMISSIONS } from '@jupyter-notebook/notebook/lib/collab/permissions';

/**
 * Interface for user information
 */
interface IUser {
  /**
   * Unique user identifier
   */
  id: string;

  /**
   * User's display name
   */
  name: string;

  /**
   * User's email address
   */
  email?: string;

  /**
   * URL to user's avatar image
   */
  avatar?: string;
}

/**
 * Interface for permission assignment
 */
interface IPermissionAssignment {
  /**
   * User information
   */
  user: IUser;

  /**
   * Assigned role
   */
  role: UserRole;
}

/**
 * Interface for sharing link
 */
interface ISharingLink {
  /**
   * Unique identifier for the link
   */
  id: string;

  /**
   * The actual URL
   */
  url: string;

  /**
   * Access level for the link
   */
  accessLevel: UserRole;

  /**
   * Whether the link has an expiration
   */
  hasExpiration: boolean;

  /**
   * Expiration date, if applicable
   */
  expirationDate?: Date;
}

/**
 * Props for the PermissionsDialog component
 */
export interface IPermissionsDialogProps {
  /**
   * Path to the notebook
   */
  path: string;

  /**
   * Permissions service
   */
  permissionsService: IPermissionsService;

  /**
   * Current user ID
   */
  currentUserId: string;

  /**
   * Translator
   */
  translator?: ITranslator;

  /**
   * Callback when dialog is closed
   */
  onClose: () => void;
}

/**
 * Tab options for the permissions dialog
 */
enum PermissionsTab {
  People = 'people',
  Sharing = 'sharing',
  Advanced = 'advanced'
}

/**
 * A dialog for managing notebook permissions
 */
export function PermissionsDialog(props: IPermissionsDialogProps): JSX.Element {
  const { path, permissionsService, currentUserId, onClose } = props;
  const translator = props.translator || nullTranslator;
  const trans = translator.load('notebook');

  // State for the active tab
  const [activeTab, setActiveTab] = useState<PermissionsTab>(PermissionsTab.People);

  // State for user permissions
  const [userPermissions, setUserPermissions] = useState<IPermissionAssignment[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<IUser[]>([]);
  const [isSearching, setIsSearching] = useState<boolean>(false);

  // State for sharing links
  const [sharingLinks, setSharingLinks] = useState<ISharingLink[]>([]);
  const [isLoadingLinks, setIsLoadingLinks] = useState<boolean>(true);
  const [newLinkAccessLevel, setNewLinkAccessLevel] = useState<UserRole>(UserRole.Viewer);
  const [newLinkExpiration, setNewLinkExpiration] = useState<string>('never');
  const [newLinkExpirationDate, setNewLinkExpirationDate] = useState<Date | null>(null);

  // State for advanced settings
  const [accessMode, setAccessMode] = useState<'private' | 'shared' | 'public'>('private');
  const [defaultRole, setDefaultRole] = useState<UserRole>(UserRole.Viewer);

  // State for tracking changes
  const [hasChanges, setHasChanges] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  /**
   * Load user permissions from the service
   */
  const loadUserPermissions = useCallback(async () => {
    setIsLoadingUsers(true);
    try {
      const docPermissions = await permissionsService.getDocumentPermissions(path);
      const userMap = await permissionsService.getDocumentUsers(path);
      
      const users: IPermissionAssignment[] = [];
      
      // Add the owner first
      const ownerInfo = await permissionsService.getUserInfo(docPermissions.owner);
      if (ownerInfo) {
        users.push({
          user: {
            id: docPermissions.owner,
            name: ownerInfo.name,
            email: ownerInfo.email,
            avatar: ownerInfo.avatar
          },
          role: UserRole.Owner
        });
      }
      
      // Add other users
      for (const [userId, permissions] of userMap.entries()) {
        // Skip the owner as we've already added them
        if (userId === docPermissions.owner) {
          continue;
        }
        
        const userInfo = await permissionsService.getUserInfo(userId);
        if (userInfo) {
          let role = UserRole.Viewer;
          
          if (permissions.manage) {
            role = UserRole.Owner;
          } else if (permissions.write) {
            role = UserRole.Editor;
          } else if (permissions.comment) {
            role = UserRole.Commenter;
          }
          
          users.push({
            user: {
              id: userId,
              name: userInfo.name,
              email: userInfo.email,
              avatar: userInfo.avatar
            },
            role
          });
        }
      }
      
      setUserPermissions(users);
      setAccessMode(docPermissions.accessMode);
      setDefaultRole(docPermissions.defaultRole || UserRole.Viewer);
    } catch (error) {
      console.error('Failed to load user permissions:', error);
      showDialog({
        title: trans.__('Error'),
        body: trans.__('Failed to load user permissions. Please try again.'),
        buttons: [Dialog.okButton()]
      });
    } finally {
      setIsLoadingUsers(false);
    }
  }, [path, permissionsService, trans]);

  /**
   * Load sharing links from the service
   */
  const loadSharingLinks = useCallback(async () => {
    setIsLoadingLinks(true);
    try {
      const links = await permissionsService.getSharingLinks(path);
      setSharingLinks(
        links.map(link => ({
          id: link.id,
          url: link.url,
          accessLevel: link.accessLevel as UserRole,
          hasExpiration: !!link.expirationDate,
          expirationDate: link.expirationDate ? new Date(link.expirationDate) : undefined
        }))
      );
    } catch (error) {
      console.error('Failed to load sharing links:', error);
      showDialog({
        title: trans.__('Error'),
        body: trans.__('Failed to load sharing links. Please try again.'),
        buttons: [Dialog.okButton()]
      });
    } finally {
      setIsLoadingLinks(false);
    }
  }, [path, permissionsService, trans]);

  /**
   * Load all data when the dialog is opened
   */
  useEffect(() => {
    loadUserPermissions();
    loadSharingLinks();
  }, [loadUserPermissions, loadSharingLinks]);

  /**
   * Search for users
   */
  const searchUsers = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    
    setIsSearching(true);
    try {
      const results = await permissionsService.searchUsers(query);
      
      // Filter out users that are already in the permissions list
      const filteredResults = results.filter(
        user => !userPermissions.some(p => p.user.id === user.id)
      );
      
      setSearchResults(filteredResults);
    } catch (error) {
      console.error('Failed to search users:', error);
    } finally {
      setIsSearching(false);
    }
  }, [permissionsService, userPermissions]);

  /**
   * Handle search input changes
   */
  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value;
    setSearchQuery(query);
    
    // Debounce search requests
    const timeoutId = setTimeout(() => {
      searchUsers(query);
    }, 300);
    
    return () => clearTimeout(timeoutId);
  }, [searchUsers]);

  /**
   * Add a user to the permissions list
   */
  const handleAddUser = useCallback((user: IUser) => {
    setUserPermissions(prev => [
      ...prev,
      {
        user,
        role: defaultRole
      }
    ]);
    setSearchResults([]);
    setSearchQuery('');
    setHasChanges(true);
  }, [defaultRole]);

  /**
   * Remove a user from the permissions list
   */
  const handleRemoveUser = useCallback((userId: string) => {
    // Cannot remove the owner
    const userToRemove = userPermissions.find(p => p.user.id === userId);
    if (userToRemove?.role === UserRole.Owner) {
      showDialog({
        title: trans.__('Cannot Remove Owner'),
        body: trans.__('The owner cannot be removed from the permissions list. Transfer ownership to another user first.'),
        buttons: [Dialog.okButton()]
      });
      return;
    }
    
    setUserPermissions(prev => prev.filter(p => p.user.id !== userId));
    setHasChanges(true);
  }, [userPermissions, trans]);

  /**
   * Change a user's role
   */
  const handleRoleChange = useCallback((userId: string, newRole: UserRole) => {
    // Cannot change the owner's role
    const userToChange = userPermissions.find(p => p.user.id === userId);
    if (userToChange?.role === UserRole.Owner && newRole !== UserRole.Owner) {
      showDialog({
        title: trans.__('Cannot Change Owner Role'),
        body: trans.__('The owner\'s role cannot be changed. Transfer ownership to another user first.'),
        buttons: [Dialog.okButton()]
      });
      return;
    }
    
    setUserPermissions(prev =>
      prev.map(p =>
        p.user.id === userId ? { ...p, role: newRole } : p
      )
    );
    setHasChanges(true);
  }, [userPermissions, trans]);

  /**
   * Transfer ownership to another user
   */
  const handleTransferOwnership = useCallback(async (newOwnerId: string) => {
    // Confirm with the user
    const result = await showDialog({
      title: trans.__('Transfer Ownership'),
      body: trans.__('Are you sure you want to transfer ownership? You will no longer be the owner of this notebook.'),
      buttons: [
        Dialog.cancelButton(),
        Dialog.okButton({ label: trans.__('Transfer') })
      ]
    });
    
    if (result.button.accept) {
      try {
        await permissionsService.transferOwnership(path, newOwnerId);
        
        // Update the local state
        setUserPermissions(prev => {
          const newPermissions = [...prev];
          
          // Find the current owner and the new owner
          const currentOwnerIndex = newPermissions.findIndex(p => p.role === UserRole.Owner);
          const newOwnerIndex = newPermissions.findIndex(p => p.user.id === newOwnerId);
          
          if (currentOwnerIndex >= 0) {
            newPermissions[currentOwnerIndex] = {
              ...newPermissions[currentOwnerIndex],
              role: UserRole.Editor
            };
          }
          
          if (newOwnerIndex >= 0) {
            newPermissions[newOwnerIndex] = {
              ...newPermissions[newOwnerIndex],
              role: UserRole.Owner
            };
          }
          
          return newPermissions;
        });
        
        showDialog({
          title: trans.__('Ownership Transferred'),
          body: trans.__('Notebook ownership has been transferred successfully.'),
          buttons: [Dialog.okButton()]
        });
      } catch (error) {
        console.error('Failed to transfer ownership:', error);
        showDialog({
          title: trans.__('Error'),
          body: trans.__('Failed to transfer ownership. Please try again.'),
          buttons: [Dialog.okButton()]
        });
      }
    }
  }, [path, permissionsService, trans]);

  /**
   * Create a new sharing link
   */
  const handleCreateLink = useCallback(async () => {
    try {
      const expirationDate = newLinkExpiration === 'never' ? undefined :
        newLinkExpiration === 'custom' ? newLinkExpirationDate :
        new Date(Date.now() + parseInt(newLinkExpiration) * 24 * 60 * 60 * 1000);
      
      const link = await permissionsService.createSharingLink(path, {
        accessLevel: newLinkAccessLevel,
        expirationDate: expirationDate?.toISOString()
      });
      
      setSharingLinks(prev => [
        ...prev,
        {
          id: link.id,
          url: link.url,
          accessLevel: link.accessLevel as UserRole,
          hasExpiration: !!link.expirationDate,
          expirationDate: link.expirationDate ? new Date(link.expirationDate) : undefined
        }
      ]);
      
      // Reset form
      setNewLinkAccessLevel(UserRole.Viewer);
      setNewLinkExpiration('never');
      setNewLinkExpirationDate(null);
    } catch (error) {
      console.error('Failed to create sharing link:', error);
      showDialog({
        title: trans.__('Error'),
        body: trans.__('Failed to create sharing link. Please try again.'),
        buttons: [Dialog.okButton()]
      });
    }
  }, [
    path,
    permissionsService,
    newLinkAccessLevel,
    newLinkExpiration,
    newLinkExpirationDate,
    trans
  ]);

  /**
   * Delete a sharing link
   */
  const handleDeleteLink = useCallback(async (linkId: string) => {
    try {
      await permissionsService.deleteSharingLink(path, linkId);
      setSharingLinks(prev => prev.filter(link => link.id !== linkId));
    } catch (error) {
      console.error('Failed to delete sharing link:', error);
      showDialog({
        title: trans.__('Error'),
        body: trans.__('Failed to delete sharing link. Please try again.'),
        buttons: [Dialog.okButton()]
      });
    }
  }, [path, permissionsService, trans]);

  /**
   * Copy a sharing link to the clipboard
   */
  const handleCopyLink = useCallback((url: string) => {
    navigator.clipboard.writeText(url).then(
      () => {
        // Show a temporary success message
        const notification = document.createElement('div');
        notification.className = 'jp-NotebookCollaboration-copyNotification';
        notification.textContent = trans.__('Link copied to clipboard');
        document.body.appendChild(notification);
        
        setTimeout(() => {
          document.body.removeChild(notification);
        }, 2000);
      },
      err => {
        console.error('Failed to copy link:', err);
      }
    );
  }, [trans]);

  /**
   * Save all changes
   */
  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      // Update access mode
      await permissionsService.setDocumentPermissions(path, {
        accessMode,
        defaultRole
      });
      
      // Update user permissions
      for (const { user, role } of userPermissions) {
        const permissions = ROLE_PERMISSIONS[role];
        await permissionsService.setUserPermissions(path, user.id, permissions);
      }
      
      setHasChanges(false);
      onClose();
    } catch (error) {
      console.error('Failed to save permissions:', error);
      showDialog({
        title: trans.__('Error'),
        body: trans.__('Failed to save permissions. Please try again.'),
        buttons: [Dialog.okButton()]
      });
    } finally {
      setIsSaving(false);
    }
  }, [
    path,
    permissionsService,
    accessMode,
    defaultRole,
    userPermissions,
    onClose,
    trans
  ]);

  /**
   * Check if the current user is the owner
   */
  const isCurrentUserOwner = useMemo(() => {
    return userPermissions.some(
      p => p.user.id === currentUserId && p.role === UserRole.Owner
    );
  }, [userPermissions, currentUserId]);

  /**
   * Filtered list of users that can be made owner
   */
  const potentialOwners = useMemo(() => {
    return userPermissions.filter(
      p => p.user.id !== currentUserId && p.role !== UserRole.Owner
    );
  }, [userPermissions, currentUserId]);

  return (
    <div className="jp-NotebookCollaboration-permissionsDialog">
      <div className="jp-NotebookCollaboration-permissionsDialogHeader">
        <h2>{trans.__('Notebook Permissions')}</h2>
        <button
          className="jp-NotebookCollaboration-closeButton"
          onClick={onClose}
          aria-label={trans.__('Close')}
        >
          <span className="jp-NotebookCollaboration-closeButtonIcon" />
        </button>
      </div>

      <div className="jp-NotebookCollaboration-permissionsDialogTabs">
        <button
          className={`jp-NotebookCollaboration-permissionsDialogTab ${activeTab === PermissionsTab.People ? 'jp-mod-active' : ''}`}
          onClick={() => setActiveTab(PermissionsTab.People)}
        >
          {trans.__('People')}
        </button>
        <button
          className={`jp-NotebookCollaboration-permissionsDialogTab ${activeTab === PermissionsTab.Sharing ? 'jp-mod-active' : ''}`}
          onClick={() => setActiveTab(PermissionsTab.Sharing)}
        >
          {trans.__('Sharing')}
        </button>
        <button
          className={`jp-NotebookCollaboration-permissionsDialogTab ${activeTab === PermissionsTab.Advanced ? 'jp-mod-active' : ''}`}
          onClick={() => setActiveTab(PermissionsTab.Advanced)}
        >
          {trans.__('Advanced')}
        </button>
      </div>

      <div className="jp-NotebookCollaboration-permissionsDialogContent">
        {activeTab === PermissionsTab.People && (
          <div className="jp-NotebookCollaboration-peopleTab">
            <div className="jp-NotebookCollaboration-searchContainer">
              <input
                type="text"
                className="jp-NotebookCollaboration-searchInput"
                placeholder={trans.__('Search for users...')}
                value={searchQuery}
                onChange={handleSearchChange}
                aria-label={trans.__('Search for users')}
              />
              {isSearching && (
                <div className="jp-NotebookCollaboration-searchSpinner" />
              )}
              {searchResults.length > 0 && (
                <div className="jp-NotebookCollaboration-searchResults">
                  {searchResults.map(user => (
                    <div
                      key={user.id}
                      className="jp-NotebookCollaboration-searchResultItem"
                      onClick={() => handleAddUser(user)}
                    >
                      {user.avatar && (
                        <img
                          src={user.avatar}
                          alt=""
                          className="jp-NotebookCollaboration-userAvatar"
                        />
                      )}
                      <div className="jp-NotebookCollaboration-userInfo">
                        <div className="jp-NotebookCollaboration-userName">
                          {user.name}
                        </div>
                        {user.email && (
                          <div className="jp-NotebookCollaboration-userEmail">
                            {user.email}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="jp-NotebookCollaboration-userList">
              {isLoadingUsers ? (
                <div className="jp-NotebookCollaboration-loading">
                  {trans.__('Loading users...')}
                </div>
              ) : userPermissions.length === 0 ? (
                <div className="jp-NotebookCollaboration-emptyState">
                  {trans.__('No users have access to this notebook.')}
                </div>
              ) : (
                userPermissions.map(({ user, role }) => (
                  <div
                    key={user.id}
                    className="jp-NotebookCollaboration-userItem"
                  >
                    <div className="jp-NotebookCollaboration-userItemLeft">
                      {user.avatar && (
                        <img
                          src={user.avatar}
                          alt=""
                          className="jp-NotebookCollaboration-userAvatar"
                        />
                      )}
                      <div className="jp-NotebookCollaboration-userInfo">
                        <div className="jp-NotebookCollaboration-userName">
                          {user.name}
                          {user.id === currentUserId && (
                            <span className="jp-NotebookCollaboration-currentUser">
                              {trans.__('(You)')}
                            </span>
                          )}
                        </div>
                        {user.email && (
                          <div className="jp-NotebookCollaboration-userEmail">
                            {user.email}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="jp-NotebookCollaboration-userItemRight">
                      <select
                        className="jp-NotebookCollaboration-roleSelect"
                        value={role}
                        onChange={e => handleRoleChange(user.id, e.target.value as UserRole)}
                        disabled={role === UserRole.Owner}
                        aria-label={trans.__('Select role')}
                      >
                        <option value={UserRole.Viewer}>{trans.__('Viewer')}</option>
                        <option value={UserRole.Commenter}>{trans.__('Commenter')}</option>
                        <option value={UserRole.Editor}>{trans.__('Editor')}</option>
                        <option value={UserRole.Owner}>{trans.__('Owner')}</option>
                      </select>
                      {role !== UserRole.Owner && (
                        <button
                          className="jp-NotebookCollaboration-removeUserButton"
                          onClick={() => handleRemoveUser(user.id)}
                          aria-label={trans.__('Remove user')}
                        >
                          <span className="jp-NotebookCollaboration-removeIcon" />
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            {isCurrentUserOwner && potentialOwners.length > 0 && (
              <div className="jp-NotebookCollaboration-transferOwnership">
                <h3>{trans.__('Transfer Ownership')}</h3>
                <p>
                  {trans.__('Transfer ownership of this notebook to another user. You will no longer be the owner.')}
                </p>
                <div className="jp-NotebookCollaboration-transferOwnershipControls">
                  <select
                    className="jp-NotebookCollaboration-transferSelect"
                    aria-label={trans.__('Select new owner')}
                  >
                    <option value="">{trans.__('Select a user...')}</option>
                    {potentialOwners.map(({ user }) => (
                      <option key={user.id} value={user.id}>
                        {user.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="jp-NotebookCollaboration-transferButton"
                    onClick={() => {
                      const select = document.querySelector('.jp-NotebookCollaboration-transferSelect') as HTMLSelectElement;
                      if (select && select.value) {
                        handleTransferOwnership(select.value);
                      }
                    }}
                  >
                    {trans.__('Transfer')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === PermissionsTab.Sharing && (
          <div className="jp-NotebookCollaboration-sharingTab">
            <div className="jp-NotebookCollaboration-createLinkSection">
              <h3>{trans.__('Create Sharing Link')}</h3>
              <div className="jp-NotebookCollaboration-createLinkControls">
                <div className="jp-NotebookCollaboration-createLinkRow">
                  <label htmlFor="link-access-level">
                    {trans.__('Access Level:')}
                  </label>
                  <select
                    id="link-access-level"
                    className="jp-NotebookCollaboration-linkAccessSelect"
                    value={newLinkAccessLevel}
                    onChange={e => setNewLinkAccessLevel(e.target.value as UserRole)}
                  >
                    <option value={UserRole.Viewer}>{trans.__('Viewer')}</option>
                    <option value={UserRole.Commenter}>{trans.__('Commenter')}</option>
                    <option value={UserRole.Editor}>{trans.__('Editor')}</option>
                  </select>
                </div>
                <div className="jp-NotebookCollaboration-createLinkRow">
                  <label htmlFor="link-expiration">
                    {trans.__('Expiration:')}
                  </label>
                  <select
                    id="link-expiration"
                    className="jp-NotebookCollaboration-linkExpirationSelect"
                    value={newLinkExpiration}
                    onChange={e => setNewLinkExpiration(e.target.value)}
                  >
                    <option value="never">{trans.__('Never')}</option>
                    <option value="1">{trans.__('1 day')}</option>
                    <option value="7">{trans.__('7 days')}</option>
                    <option value="30">{trans.__('30 days')}</option>
                    <option value="custom">{trans.__('Custom date')}</option>
                  </select>
                </div>
                {newLinkExpiration === 'custom' && (
                  <div className="jp-NotebookCollaboration-createLinkRow">
                    <label htmlFor="link-expiration-date">
                      {trans.__('Expiration Date:')}
                    </label>
                    <input
                      id="link-expiration-date"
                      type="date"
                      className="jp-NotebookCollaboration-linkExpirationDate"
                      value={newLinkExpirationDate ? newLinkExpirationDate.toISOString().split('T')[0] : ''}
                      onChange={e => {
                        const date = e.target.value ? new Date(e.target.value) : null;
                        setNewLinkExpirationDate(date);
                      }}
                      min={new Date().toISOString().split('T')[0]}
                    />
                  </div>
                )}
                <button
                  className="jp-NotebookCollaboration-createLinkButton"
                  onClick={handleCreateLink}
                >
                  {trans.__('Create Link')}
                </button>
              </div>
            </div>

            <div className="jp-NotebookCollaboration-existingLinksSection">
              <h3>{trans.__('Existing Links')}</h3>
              {isLoadingLinks ? (
                <div className="jp-NotebookCollaboration-loading">
                  {trans.__('Loading links...')}
                </div>
              ) : sharingLinks.length === 0 ? (
                <div className="jp-NotebookCollaboration-emptyState">
                  {trans.__('No sharing links have been created.')}
                </div>
              ) : (
                <div className="jp-NotebookCollaboration-linkList">
                  {sharingLinks.map(link => (
                    <div
                      key={link.id}
                      className="jp-NotebookCollaboration-linkItem"
                    >
                      <div className="jp-NotebookCollaboration-linkItemLeft">
                        <div className="jp-NotebookCollaboration-linkUrl">
                          {link.url}
                        </div>
                        <div className="jp-NotebookCollaboration-linkDetails">
                          <span className="jp-NotebookCollaboration-linkAccess">
                            {trans.__('Access:')} {trans.__(link.accessLevel)}
                          </span>
                          {link.hasExpiration && (
                            <span className="jp-NotebookCollaboration-linkExpiration">
                              {trans.__('Expires:')} {link.expirationDate?.toLocaleDateString()}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="jp-NotebookCollaboration-linkItemRight">
                        <button
                          className="jp-NotebookCollaboration-copyLinkButton"
                          onClick={() => handleCopyLink(link.url)}
                          aria-label={trans.__('Copy link')}
                        >
                          <span className="jp-NotebookCollaboration-copyIcon" />
                        </button>
                        <button
                          className="jp-NotebookCollaboration-deleteLinkButton"
                          onClick={() => handleDeleteLink(link.id)}
                          aria-label={trans.__('Delete link')}
                        >
                          <span className="jp-NotebookCollaboration-deleteIcon" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === PermissionsTab.Advanced && (
          <div className="jp-NotebookCollaboration-advancedTab">
            <div className="jp-NotebookCollaboration-accessModeSection">
              <h3>{trans.__('Access Mode')}</h3>
              <div className="jp-NotebookCollaboration-accessModeOptions">
                <div className="jp-NotebookCollaboration-accessModeOption">
                  <input
                    type="radio"
                    id="access-private"
                    name="access-mode"
                    value="private"
                    checked={accessMode === 'private'}
                    onChange={() => {
                      setAccessMode('private');
                      setHasChanges(true);
                    }}
                  />
                  <label htmlFor="access-private">
                    <div className="jp-NotebookCollaboration-accessModeTitle">
                      {trans.__('Private')}
                    </div>
                    <div className="jp-NotebookCollaboration-accessModeDescription">
                      {trans.__('Only people with explicit permissions can access this notebook.')}
                    </div>
                  </label>
                </div>
                <div className="jp-NotebookCollaboration-accessModeOption">
                  <input
                    type="radio"
                    id="access-shared"
                    name="access-mode"
                    value="shared"
                    checked={accessMode === 'shared'}
                    onChange={() => {
                      setAccessMode('shared');
                      setHasChanges(true);
                    }}
                  />
                  <label htmlFor="access-shared">
                    <div className="jp-NotebookCollaboration-accessModeTitle">
                      {trans.__('Shared')}
                    </div>
                    <div className="jp-NotebookCollaboration-accessModeDescription">
                      {trans.__('Anyone with the link can access this notebook with the default role.')}
                    </div>
                  </label>
                </div>
                <div className="jp-NotebookCollaboration-accessModeOption">
                  <input
                    type="radio"
                    id="access-public"
                    name="access-mode"
                    value="public"
                    checked={accessMode === 'public'}
                    onChange={() => {
                      setAccessMode('public');
                      setHasChanges(true);
                    }}
                  />
                  <label htmlFor="access-public">
                    <div className="jp-NotebookCollaboration-accessModeTitle">
                      {trans.__('Public')}
                    </div>
                    <div className="jp-NotebookCollaboration-accessModeDescription">
                      {trans.__('Anyone in your organization can find and access this notebook with the default role.')}
                    </div>
                  </label>
                </div>
              </div>
            </div>

            <div className="jp-NotebookCollaboration-defaultRoleSection">
              <h3>{trans.__('Default Role for New Users')}</h3>
              <p>
                {trans.__('This role will be assigned to new users who gain access through sharing links or public access.')}
              </p>
              <select
                className="jp-NotebookCollaboration-defaultRoleSelect"
                value={defaultRole}
                onChange={e => {
                  setDefaultRole(e.target.value as UserRole);
                  setHasChanges(true);
                }}
                aria-label={trans.__('Default role for new users')}
              >
                <option value={UserRole.Viewer}>{trans.__('Viewer')}</option>
                <option value={UserRole.Commenter}>{trans.__('Commenter')}</option>
                <option value={UserRole.Editor}>{trans.__('Editor')}</option>
              </select>
            </div>
          </div>
        )}
      </div>

      <div className="jp-NotebookCollaboration-permissionsDialogFooter">
        <button
          className="jp-NotebookCollaboration-cancelButton"
          onClick={onClose}
        >
          {trans.__('Cancel')}
        </button>
        <button
          className="jp-NotebookCollaboration-saveButton"
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
        >
          {isSaving ? trans.__('Saving...') : trans.__('Save')}
        </button>
      </div>
    </div>
  );
}

/**
 * A namespace for PermissionsDialog statics.
 */
export namespace PermissionsDialog {
  /**
   * Open the permissions dialog.
   *
   * @param options - The dialog options.
   * @returns A promise that resolves when the dialog is closed.
   */
  export function open(options: IPermissionsDialogOptions): Promise<void> {
    const { path, permissionsService, currentUserId, translator } = options;

    return new Promise<void>(resolve => {
      const dialog = new Dialog({
        title: '',
        body: (
          <PermissionsDialog
            path={path}
            permissionsService={permissionsService}
            currentUserId={currentUserId}
            translator={translator}
            onClose={() => {
              dialog.resolve();
              resolve();
            }}
          />
        ),
        buttons: [],
        defaultButton: -1,
        renderer: options.renderer
      });

      dialog.launch();
    });
  }

  /**
   * Options for opening the permissions dialog.
   */
  export interface IPermissionsDialogOptions {
    /**
     * Path to the notebook.
     */
    path: string;

    /**
     * Permissions service.
     */
    permissionsService: IPermissionsService;

    /**
     * Current user ID.
     */
    currentUserId: string;

    /**
     * Translator.
     */
    translator?: ITranslator;

    /**
     * Dialog renderer.
     */
    renderer?: Dialog.IRenderer;
  }
}