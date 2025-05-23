/**
 * User presence and awareness UI component for real-time collaboration in Jupyter notebooks.
 * This component displays avatars, cursor positions, and active cell indicators for all connected users.
 * It subscribes to the Yjs awareness protocol events via the IAwarenessService to track user locations
 * and status changes.
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { Notebook, NotebookPanel } from '@jupyterlab/notebook';
import { IAwarenessService } from '../../../notebook/src/collab/awareness';
import { IAwarenessState, IUserMetadata, ICursorPosition } from '../../../notebook/src/collab/awareness';

/**
 * Properties for the UserPresenceComponent
 */
interface IUserPresenceProps {
  /**
   * The awareness service for tracking user presence
   */
  awarenessService: IAwarenessService;

  /**
   * The notebook panel containing the notebook
   */
  notebookPanel: NotebookPanel;

  /**
   * The translator for internationalization
   */
  translator?: ITranslator;

  /**
   * Maximum number of avatars to display before showing a +N indicator
   */
  maxVisibleAvatars?: number;
}

/**
 * Generate a consistent color for a user based on their ID
 * 
 * @param userId - The user ID to generate a color for
 * @returns A hex color string
 */
function generateUserColor(userId: string): string {
  // Simple hash function to generate a number from a string
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash) + userId.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }

  // Use a predefined palette of colors that work well for user interfaces
  const colors = [
    '#4285F4', // Blue
    '#EA4335', // Red
    '#FBBC05', // Yellow
    '#34A853', // Green
    '#8E44AD', // Purple
    '#F39C12', // Orange
    '#16A085', // Teal
    '#E74C3C', // Bright Red
    '#3498DB', // Light Blue
    '#1ABC9C', // Turquoise
    '#2ECC71', // Emerald
    '#E67E22', // Carrot
    '#9B59B6'  // Amethyst
  ];

  // Use the hash to select a color from the palette
  const index = Math.abs(hash) % colors.length;
  return colors[index];
}

/**
 * Get user initials from their name
 * 
 * @param name - The user's full name
 * @returns The user's initials (up to 2 characters)
 */
function getUserInitials(name: string): string {
  if (!name) return '?';
  
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].substring(0, 2).toUpperCase();
  }
  
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Format time elapsed since a timestamp
 * 
 * @param timestamp - The timestamp in milliseconds
 * @returns A human-readable string representing the elapsed time
 */
function formatTimeElapsed(timestamp: number): string {
  const now = Date.now();
  const elapsed = now - timestamp;
  
  if (elapsed < 60000) { // Less than a minute
    return 'just now';
  } else if (elapsed < 3600000) { // Less than an hour
    const minutes = Math.floor(elapsed / 60000);
    return `${minutes} min ago`;
  } else if (elapsed < 86400000) { // Less than a day
    const hours = Math.floor(elapsed / 3600000);
    return `${hours} hr ago`;
  } else {
    const days = Math.floor(elapsed / 86400000);
    return `${days} day${days > 1 ? 's' : ''} ago`;
  }
}

/**
 * User avatar component that displays a user's avatar or initials
 */
const UserAvatar: React.FC<{
  user: IUserMetadata;
  isIdle: boolean;
  onClick?: () => void;
}> = ({ user, isIdle, onClick }) => {
  const userColor = useMemo(() => generateUserColor(user.id), [user.id]);
  const initials = useMemo(() => getUserInitials(user.name), [user.name]);
  
  return (
    <div 
      className={`jp-CollabAvatar ${isIdle ? 'jp-mod-idle' : ''}`}
      style={{ borderColor: userColor, backgroundColor: userColor }}
      onClick={onClick}
      data-user-id={user.id}
    >
      {user.avatar ? (
        <img src={user.avatar} alt={user.name} />
      ) : (
        <span>{initials}</span>
      )}
    </div>
  );
};

/**
 * Tooltip component that displays user information on hover
 */
const UserTooltip: React.FC<{
  user: IUserMetadata;
  activity?: { type: string; timestamp: number };
}> = ({ user, activity }) => {
  return (
    <div className="jp-CollabTooltip">
      <div className="jp-CollabTooltip-user">
        <span className="jp-CollabTooltip-name">{user.name}</span>
        {activity && (
          <span className="jp-CollabTooltip-status">
            {activity.type === 'editing' ? 'editing' : 
             activity.type === 'viewing' ? 'viewing' : 
             activity.type}
          </span>
        )}
      </div>
      {activity && (
        <div className="jp-CollabTooltip-time">
          {formatTimeElapsed(activity.timestamp)}
        </div>
      )}
    </div>
  );
};

/**
 * Component that displays a group of user avatars
 */
const UserAvatarGroup: React.FC<{
  users: Map<number, IAwarenessState>;
  maxVisible: number;
  onAvatarClick: (clientId: number) => void;
}> = ({ users, maxVisible, onAvatarClick }) => {
  // Convert users map to array and sort by activity timestamp (most recent first)
  const sortedUsers = useMemo(() => {
    return Array.from(users.entries())
      .filter(([_, state]) => state.user) // Filter out users without user metadata
      .sort(([_, stateA], [_, stateB]) => {
        const timeA = stateA.activity?.timestamp || 0;
        const timeB = stateB.activity?.timestamp || 0;
        return timeB - timeA;
      });
  }, [users]);

  // Determine which users to show and how many are hidden
  const visibleUsers = sortedUsers.slice(0, maxVisible);
  const hiddenCount = Math.max(0, sortedUsers.length - maxVisible);

  return (
    <div className="jp-CollabAvatarGroup">
      {hiddenCount > 0 && (
        <>
          <div className="jp-CollabAvatarMore">
            +{hiddenCount}
          </div>
          <UserTooltip 
            user={{ name: `${hiddenCount} more user${hiddenCount > 1 ? 's' : ''}` } as IUserMetadata} 
          />
        </>
      )}
      
      {visibleUsers.map(([clientId, state]) => {
        const isIdle = state.activity?.type === 'idle' || 
                      (Date.now() - (state.activity?.timestamp || 0) > 60000); // Idle after 1 minute
        
        return (
          <React.Fragment key={clientId}>
            <UserAvatar 
              user={state.user} 
              isIdle={isIdle}
              onClick={() => onAvatarClick(clientId)} 
            />
            <UserTooltip user={state.user} activity={state.activity} />
          </React.Fragment>
        );
      })}
    </div>
  );
};

/**
 * Main component for user presence in collaborative notebooks
 */
export const UserPresenceComponent: React.FC<IUserPresenceProps> = ({
  awarenessService,
  notebookPanel,
  translator = nullTranslator,
  maxVisibleAvatars = 3
}) => {
  const [users, setUsers] = useState<Map<number, IAwarenessState>>(new Map());
  const trans = translator.load('notebook');
  
  // Handle awareness state changes
  const handleAwarenessChange = useCallback((changes: { added: number[]; updated: number[]; removed: number[] }) => {
    setUsers(new Map(awarenessService.getStates()));
  }, [awarenessService]);

  // Focus on a user's cursor position
  const focusOnUser = useCallback((clientId: number) => {
    const state = users.get(clientId);
    if (!state || !state.cursor || !notebookPanel.content) {
      return;
    }

    const { cellIndex } = state.cursor;
    const cells = notebookPanel.content.widgets;
    
    if (cellIndex >= 0 && cellIndex < cells.length) {
      // Activate the cell
      notebookPanel.content.activeCellIndex = cellIndex;
      
      // Scroll to the cell
      const cell = cells[cellIndex];
      cell.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [users, notebookPanel]);

  // Set up event listeners when the component mounts
  useEffect(() => {
    // Subscribe to awareness changes
    awarenessService.stateChanged.connect(handleAwarenessChange);
    
    // Initialize with current state
    setUsers(new Map(awarenessService.getStates()));
    
    return () => {
      // Clean up event listeners when the component unmounts
      awarenessService.stateChanged.disconnect(handleAwarenessChange);
    };
  }, [awarenessService, handleAwarenessChange]);

  // Render remote cursors and selections
  useEffect(() => {
    const notebook = notebookPanel.content;
    if (!notebook) return;

    // Clean up function to remove all cursor elements
    const cleanup = () => {
      document.querySelectorAll('.jp-CollabCursor, .jp-CollabSelection').forEach(el => el.remove());
    };

    // Create cursor and selection elements for each user
    users.forEach((state, clientId) => {
      // Skip if this is the local user or if there's no cursor information
      if (clientId === awarenessService.clientID || !state.cursor) return;
      
      const { cellIndex, offset, selection } = state.cursor;
      const cells = notebook.widgets;
      
      if (cellIndex >= 0 && cellIndex < cells.length) {
        const cell = cells[cellIndex];
        const editor = cell.editor;
        
        if (editor) {
          const userColor = generateUserColor(state.user.id);
          const initials = getUserInitials(state.user.name);
          
          // Create cursor element
          if (offset !== undefined) {
            const pos = editor.getPositionAt(offset);
            if (pos) {
              const coords = editor.getCoordinateForPosition(pos);
              
              // Create cursor element
              const cursor = document.createElement('div');
              cursor.className = 'jp-CollabCursor';
              cursor.style.color = userColor;
              cursor.style.left = `${coords.left}px`;
              cursor.style.top = `${coords.top}px`;
              cursor.setAttribute('data-user-initials', initials);
              cursor.setAttribute('data-user-id', state.user.id);
              
              cell.node.appendChild(cursor);
            }
          }
          
          // Create selection element if there's a selection
          if (selection && selection.start !== selection.end) {
            const startPos = editor.getPositionAt(selection.start);
            const endPos = editor.getPositionAt(selection.end);
            
            if (startPos && endPos) {
              // Get all the line segments that need to be highlighted
              const ranges = editor.getLineSegmentsForRange({
                start: startPos,
                end: endPos
              });
              
              // Create selection elements for each range
              ranges.forEach(range => {
                const selElement = document.createElement('div');
                selElement.className = 'jp-CollabSelection';
                selElement.style.color = userColor;
                selElement.style.left = `${range.left}px`;
                selElement.style.top = `${range.top}px`;
                selElement.style.width = `${range.width}px`;
                selElement.style.height = `${range.height}px`;
                selElement.setAttribute('data-user-id', state.user.id);
                
                cell.node.appendChild(selElement);
              });
            }
          }
        }
      }
    });

    // Clean up cursors and selections when component updates
    return cleanup;
  }, [users, notebookPanel, awarenessService.clientID]);

  return (
    <div className="jp-CollabPresence">
      <UserAvatarGroup 
        users={users} 
        maxVisible={maxVisibleAvatars} 
        onAvatarClick={focusOnUser} 
      />
    </div>
  );
};

/**
 * A namespace for UserPresenceComponent statics.
 */
export namespace UserPresenceComponent {
  /**
   * Create a new UserPresenceComponent widget
   *
   * @param options - The options for creating the component
   * @returns A new UserPresenceComponent widget
   */
  export function createWidget(options: {
    awarenessService: IAwarenessService;
    notebookPanel: NotebookPanel;
    translator?: ITranslator;
  }): ReactWidget {
    const { awarenessService, notebookPanel, translator } = options;
    
    return ReactWidget.create(
      <UserPresenceComponent
        awarenessService={awarenessService}
        notebookPanel={notebookPanel}
        translator={translator}
      />
    );
  }
}