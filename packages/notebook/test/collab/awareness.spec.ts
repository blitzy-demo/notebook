/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

import { Doc } from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { YjsAwareness, IAwarenessState, ICursorPosition, IUserMetadata, IUserActivity } from '../../src/collab/awareness';

// Mock for y-protocols/awareness
jest.mock('y-protocols/awareness', () => {
  // Create a mock implementation of Awareness
  const mockAwareness = {
    clientID: 1,
    getStates: jest.fn(),
    getLocalState: jest.fn(),
    setLocalState: jest.fn(),
    setLocalStateField: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
  };

  return {
    Awareness: jest.fn(() => mockAwareness),
    removeAwarenessStates: jest.fn(),
    encodeAwarenessUpdate: jest.fn(),
    applyAwarenessUpdate: jest.fn(),
  };
});

describe('YjsAwareness', () => {
  let doc: Doc;
  let awareness: YjsAwareness;
  let mockAwareness: any;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Create a new Yjs document for each test
    doc = new Doc();

    // Create a new YjsAwareness instance
    awareness = new YjsAwareness(doc);

    // Get the mock Awareness instance
    mockAwareness = (awarenessProtocol.Awareness as jest.Mock).mock.results[0].value;
  });

  afterEach(() => {
    // Clean up
    awareness.destroy();
  });

  describe('constructor', () => {
    it('should create a new YjsAwareness instance', () => {
      expect(awareness).toBeInstanceOf(YjsAwareness);
    });

    it('should initialize with the provided Yjs document', () => {
      expect(awarenessProtocol.Awareness).toHaveBeenCalledWith(doc);
    });

    it('should set up event listeners for awareness updates', () => {
      expect(mockAwareness.on).toHaveBeenCalledWith('update', expect.any(Function));
    });

    it('should attempt to restore local state from storage', () => {
      // Mock localStorage.getItem
      const localStorageSpy = jest.spyOn(Storage.prototype, 'getItem');
      localStorageSpy.mockReturnValue(JSON.stringify({ user: { name: 'Test User' } }));

      // Create a new instance to trigger the constructor
      const newAwareness = new YjsAwareness(doc);

      // Verify localStorage was checked
      expect(localStorageSpy).toHaveBeenCalled();
      
      // Verify the local state was set from storage
      expect(mockAwareness.setLocalState).toHaveBeenCalledWith({ user: { name: 'Test User' } });

      // Clean up
      localStorageSpy.mockRestore();
      newAwareness.destroy();
    });

    it('should handle errors when restoring from invalid storage data', () => {
      // Mock localStorage.getItem to return invalid JSON
      const localStorageSpy = jest.spyOn(Storage.prototype, 'getItem');
      localStorageSpy.mockReturnValue('invalid-json');

      // Mock console.warn to verify warning is logged
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

      // Create a new instance to trigger the constructor
      const newAwareness = new YjsAwareness(doc);

      // Verify warning was logged
      expect(consoleWarnSpy).toHaveBeenCalledWith('Failed to restore awareness state:', expect.any(Error));

      // Clean up
      localStorageSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      newAwareness.destroy();
    });
  });

  describe('clientID', () => {
    it('should return the client ID from the awareness instance', () => {
      mockAwareness.clientID = 42;
      expect(awareness.clientID).toBe(42);
    });
  });

  describe('getStates', () => {
    it('should return all awareness states', () => {
      const mockStates = new Map([
        [1, { user: { name: 'User 1' } }],
        [2, { user: { name: 'User 2' } }]
      ]);
      mockAwareness.getStates.mockReturnValue(mockStates);

      const states = awareness.getStates();
      expect(states).toBe(mockStates);
      expect(mockAwareness.getStates).toHaveBeenCalled();
    });
  });

  describe('getLocalState', () => {
    it('should return the local awareness state', () => {
      const mockLocalState = { user: { name: 'Local User' } };
      mockAwareness.getLocalState.mockReturnValue(mockLocalState);

      const localState = awareness.getLocalState();
      expect(localState).toBe(mockLocalState);
      expect(mockAwareness.getLocalState).toHaveBeenCalled();
    });

    it('should return null if no local state exists', () => {
      mockAwareness.getLocalState.mockReturnValue(null);

      const localState = awareness.getLocalState();
      expect(localState).toBeNull();
    });
  });

  describe('setLocalState', () => {
    it('should set the local awareness state', () => {
      const newState: IAwarenessState = {
        user: { name: 'New User', avatar: 'avatar.png', role: 'editor' }
      };

      awareness.setLocalState(newState);

      expect(mockAwareness.setLocalState).toHaveBeenCalledWith(newState);
    });

    it('should persist the local state to storage', () => {
      // Mock localStorage.setItem
      const localStorageSpy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation();
      
      // Mock getLocalState to return a state after setting
      const mockState = { user: { name: 'Test User' } };
      mockAwareness.getLocalState.mockReturnValue(mockState);

      // Set the local state
      awareness.setLocalState(mockState);

      // Verify localStorage was updated
      expect(localStorageSpy).toHaveBeenCalledWith(
        expect.stringContaining('jupyter-notebook-awareness'),
        JSON.stringify(mockState)
      );

      // Clean up
      localStorageSpy.mockRestore();
    });

    it('should handle null state to mark user as offline', () => {
      awareness.setLocalState(null);
      expect(mockAwareness.setLocalState).toHaveBeenCalledWith(null);
    });
  });

  describe('setLocalStateField', () => {
    it('should update a specific field in the local state', () => {
      const field = 'cursor';
      const value: ICursorPosition = {
        cellIndex: 2,
        offset: 10,
        active: true,
        selection: { start: 5, end: 15 }
      };

      awareness.setLocalStateField(field, value);

      expect(mockAwareness.setLocalStateField).toHaveBeenCalledWith(field, value);
    });

    it('should persist the updated state to storage', () => {
      // Mock localStorage.setItem
      const localStorageSpy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation();
      
      // Mock getLocalState to return a state after setting
      const mockState = { user: { name: 'Test User' }, activity: { type: 'editing' } };
      mockAwareness.getLocalState.mockReturnValue(mockState);

      // Update a field
      awareness.setLocalStateField('activity', { type: 'editing', timestamp: Date.now() });

      // Verify localStorage was updated
      expect(localStorageSpy).toHaveBeenCalled();

      // Clean up
      localStorageSpy.mockRestore();
    });
  });

  describe('removeStates', () => {
    it('should remove awareness states for specified clients', () => {
      const clients = [2, 3];
      const origin = 'test';

      awareness.removeStates(clients, origin);

      expect(awarenessProtocol.removeAwarenessStates).toHaveBeenCalledWith(
        mockAwareness,
        clients,
        origin
      );
    });
  });

  describe('destroy', () => {
    it('should clean up resources and event listeners', () => {
      awareness.destroy();

      expect(mockAwareness.off).toHaveBeenCalledWith('update', expect.any(Function));
    });

    it('should clear local state', () => {
      awareness.destroy();

      expect(mockAwareness.setLocalState).toHaveBeenCalledWith(null);
    });

    it('should remove beforeunload event listener if in browser environment', () => {
      // Mock window.removeEventListener
      const removeEventListenerSpy = jest.spyOn(window, 'removeEventListener');

      awareness.destroy();

      expect(removeEventListenerSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));

      // Clean up
      removeEventListenerSpy.mockRestore();
    });
  });

  describe('encodeUpdate', () => {
    it('should encode awareness updates for specified clients', () => {
      const clients = [1, 2];
      const mockEncodedUpdate = new Uint8Array([1, 2, 3]);
      
      (awarenessProtocol.encodeAwarenessUpdate as jest.Mock).mockReturnValue(mockEncodedUpdate);

      const encodedUpdate = awareness.encodeUpdate(clients);

      expect(awarenessProtocol.encodeAwarenessUpdate).toHaveBeenCalledWith(mockAwareness, clients);
      expect(encodedUpdate).toBe(mockEncodedUpdate);
    });
  });

  describe('applyUpdate', () => {
    it('should apply encoded awareness updates', () => {
      const update = new Uint8Array([1, 2, 3]);
      const origin = 'test';

      awareness.applyUpdate(update, origin);

      expect(awarenessProtocol.applyAwarenessUpdate).toHaveBeenCalledWith(
        mockAwareness,
        update,
        origin
      );
    });
  });

  describe('awareness events', () => {
    it('should emit stateChanged signal when awareness is updated', () => {
      // Create a mock for the signal handler
      const mockSignalHandler = jest.fn();
      awareness.stateChanged.connect(mockSignalHandler);

      // Get the update handler that was registered
      const updateHandler = mockAwareness.on.mock.calls.find(
        call => call[0] === 'update'
      )[1];

      // Simulate an awareness update event
      const changes = { added: [2], updated: [3], removed: [4] };
      const origin = 'test';
      updateHandler(changes, origin);

      // Verify the signal was emitted with the changes
      expect(mockSignalHandler).toHaveBeenCalledWith(awareness, changes);

      // Clean up
      awareness.stateChanged.disconnect(mockSignalHandler);
    });

    it('should persist local state when local client is in updated list', () => {
      // Mock localStorage.setItem
      const localStorageSpy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation();
      
      // Mock client ID and local state
      mockAwareness.clientID = 3;
      mockAwareness.getLocalState.mockReturnValue({ user: { name: 'Updated User' } });

      // Get the update handler that was registered
      const updateHandler = mockAwareness.on.mock.calls.find(
        call => call[0] === 'update'
      )[1];

      // Simulate an awareness update event with the local client in the updated list
      updateHandler({ added: [], updated: [3], removed: [] }, 'test');

      // Verify localStorage was updated
      expect(localStorageSpy).toHaveBeenCalled();

      // Clean up
      localStorageSpy.mockRestore();
    });

    it('should not persist local state when local client is not in updated list', () => {
      // Mock localStorage.setItem
      const localStorageSpy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation();
      
      // Mock client ID
      mockAwareness.clientID = 3;

      // Get the update handler that was registered
      const updateHandler = mockAwareness.on.mock.calls.find(
        call => call[0] === 'update'
      )[1];

      // Simulate an awareness update event with other clients
      updateHandler({ added: [1], updated: [2], removed: [4] }, 'test');

      // Verify localStorage was not updated
      expect(localStorageSpy).not.toHaveBeenCalled();

      // Clean up
      localStorageSpy.mockRestore();
    });
  });

  describe('beforeunload handling', () => {
    it('should remove local client state on beforeunload', () => {
      // Get the beforeunload handler that was registered
      const beforeunloadHandler = jest.spyOn(window, 'addEventListener').mock.calls.find(
        call => call[0] === 'beforeunload'
      )[1];

      // Mock client ID
      mockAwareness.clientID = 5;

      // Simulate beforeunload event
      beforeunloadHandler();

      // Verify removeAwarenessStates was called with the local client ID
      expect(awarenessProtocol.removeAwarenessStates).toHaveBeenCalledWith(
        mockAwareness,
        [5],
        'window unload'
      );
    });
  });

  describe('integration with UI components', () => {
    it('should provide user metadata for UI components', () => {
      // Set up mock states with user metadata
      const mockStates = new Map([
        [1, { user: { name: 'User 1', avatar: 'avatar1.png', role: 'editor' } }],
        [2, { user: { name: 'User 2', avatar: 'avatar2.png', role: 'viewer' } }]
      ]);
      mockAwareness.getStates.mockReturnValue(mockStates);

      // Get all states
      const states = awareness.getStates();

      // Verify we can extract user metadata for UI components
      const users = Array.from(states.entries()).map(([clientId, state]) => {
        return {
          clientId,
          name: state.user.name,
          avatar: state.user.avatar,
          role: state.user.role
        };
      });

      expect(users).toEqual([
        { clientId: 1, name: 'User 1', avatar: 'avatar1.png', role: 'editor' },
        { clientId: 2, name: 'User 2', avatar: 'avatar2.png', role: 'viewer' }
      ]);
    });

    it('should provide cursor positions for UI components', () => {
      // Set up mock states with cursor positions
      const mockStates = new Map([
        [1, {
          user: { name: 'User 1' },
          cursor: { cellIndex: 0, offset: 5, active: true, selection: { start: 2, end: 8 } }
        }],
        [2, {
          user: { name: 'User 2' },
          cursor: { cellIndex: 1, offset: 10, active: true }
        }]
      ]);
      mockAwareness.getStates.mockReturnValue(mockStates);

      // Get all states
      const states = awareness.getStates();

      // Verify we can extract cursor positions for UI components
      const cursors = Array.from(states.entries())
        .filter(([_, state]) => state.cursor)
        .map(([clientId, state]) => {
          return {
            clientId,
            userName: state.user.name,
            cellIndex: state.cursor.cellIndex,
            offset: state.cursor.offset,
            hasSelection: !!state.cursor.selection
          };
        });

      expect(cursors).toEqual([
        { clientId: 1, userName: 'User 1', cellIndex: 0, offset: 5, hasSelection: true },
        { clientId: 2, userName: 'User 2', cellIndex: 1, offset: 10, hasSelection: false }
      ]);
    });

    it('should provide user activity information for UI components', () => {
      // Set up mock states with activity information
      const now = Date.now();
      const mockStates = new Map([
        [1, {
          user: { name: 'User 1' },
          activity: { type: 'editing', timestamp: now, metadata: { cellId: 'cell1' } }
        }],
        [2, {
          user: { name: 'User 2' },
          activity: { type: 'viewing', timestamp: now - 5000 }
        }]
      ]);
      mockAwareness.getStates.mockReturnValue(mockStates);

      // Get all states
      const states = awareness.getStates();

      // Verify we can extract activity information for UI components
      const activities = Array.from(states.entries())
        .filter(([_, state]) => state.activity)
        .map(([clientId, state]) => {
          return {
            clientId,
            userName: state.user.name,
            activityType: state.activity.type,
            timestamp: state.activity.timestamp
          };
        });

      expect(activities).toEqual([
        { clientId: 1, userName: 'User 1', activityType: 'editing', timestamp: now },
        { clientId: 2, userName: 'User 2', activityType: 'viewing', timestamp: now - 5000 }
      ]);
    });
  });

  describe('error handling', () => {
    it('should handle errors when persisting local state', () => {
      // Mock localStorage.setItem to throw an error
      const localStorageSpy = jest.spyOn(Storage.prototype, 'setItem');
      localStorageSpy.mockImplementation(() => {
        throw new Error('Storage quota exceeded');
      });

      // Mock console.warn
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

      // Set local state which should trigger persistence
      awareness.setLocalState({ user: { name: 'Test User' } });

      // Verify warning was logged
      expect(consoleWarnSpy).toHaveBeenCalledWith('Failed to persist awareness state:', expect.any(Error));

      // Clean up
      localStorageSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    });

    it('should handle missing localStorage in non-browser environments', () => {
      // Save original localStorage
      const originalLocalStorage = window.localStorage;

      // Mock window.localStorage to be undefined
      Object.defineProperty(window, 'localStorage', {
        value: undefined,
        writable: true
      });

      // This should not throw an error
      expect(() => {
        awareness.setLocalState({ user: { name: 'Test User' } });
      }).not.toThrow();

      // Restore original localStorage
      Object.defineProperty(window, 'localStorage', {
        value: originalLocalStorage,
        writable: true
      });
    });
  });

  describe('network disconnection handling', () => {
    it('should handle reconnection by re-applying awareness state', () => {
      // Mock local state
      const mockLocalState = { user: { name: 'Local User' } };
      mockAwareness.getLocalState.mockReturnValue(mockLocalState);

      // Simulate network disconnection and reconnection
      // In a real scenario, the provider would handle this and re-apply the state
      // Here we just verify that our methods work correctly for this use case

      // 1. Encode the current state before disconnection
      const encodedState = awareness.encodeUpdate([mockAwareness.clientID]);
      
      // 2. Clear the state (simulating disconnection)
      awareness.setLocalState(null);
      expect(mockAwareness.setLocalState).toHaveBeenCalledWith(null);

      // 3. Re-apply the state after reconnection
      awareness.applyUpdate(encodedState);
      expect(awarenessProtocol.applyAwarenessUpdate).toHaveBeenCalledWith(
        mockAwareness,
        encodedState,
        undefined
      );
    });

    it('should handle remote client disconnection', () => {
      // Set up mock states with multiple clients
      const mockStates = new Map([
        [1, { user: { name: 'User 1' } }],
        [2, { user: { name: 'User 2' } }],
        [3, { user: { name: 'User 3' } }]
      ]);
      mockAwareness.getStates.mockReturnValue(mockStates);

      // Simulate a client disconnection
      awareness.removeStates([2]);

      // Verify removeAwarenessStates was called correctly
      expect(awarenessProtocol.removeAwarenessStates).toHaveBeenCalledWith(
        mockAwareness,
        [2],
        undefined
      );
    });
  });
});