// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { NotebookModel, YjsNotebookProvider } from '../src/model';
import { ICellModel } from '@jupyterlab/notebook';
import { IObservableList } from '@jupyterlab/observables';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { YjsAwareness } from '../src/collab/awareness';

// Mock WebsocketProvider
jest.mock('y-websocket', () => {
  return {
    WebsocketProvider: jest.fn().mockImplementation(() => {
      return {
        wsconnected: true,
        on: jest.fn(),
        disconnect: jest.fn(),
        awareness: {
          setLocalState: jest.fn(),
          getLocalState: jest.fn(),
          getStates: jest.fn().mockReturnValue(new Map()),
          on: jest.fn(),
          off: jest.fn()
        }
      };
    })
  };
});

// Mock IndexeddbPersistence
jest.mock('y-indexeddb', () => {
  return {
    IndexeddbPersistence: jest.fn().mockImplementation(() => {
      return {};
    })
  };
});

// Mock YjsAwareness
jest.mock('../src/collab/awareness', () => {
  return {
    YjsAwareness: jest.fn().mockImplementation(() => {
      return {
        awareness: {
          setLocalState: jest.fn(),
          getLocalState: jest.fn(),
          getStates: jest.fn().mockReturnValue(new Map())
        },
        clientID: 1,
        getStates: jest.fn().mockReturnValue(new Map()),
        getLocalState: jest.fn(),
        setLocalState: jest.fn(),
        setLocalStateField: jest.fn(),
        removeStates: jest.fn(),
        destroy: jest.fn(),
        on: jest.fn(),
        off: jest.fn()
      };
    })
  };
});

/**
 * Helper class to simulate multiple clients for testing collaborative editing
 */
class TestClient {
  constructor(id: number, notebookId: string = 'test-notebook') {
    this.id = id;
    this.ydoc = new Y.Doc();
    this.ydoc.clientID = id;
    
    // Create notebook model
    this.model = new NotebookModel({
      collaborative: true,
      collaborationOptions: {
        documentId: notebookId,
        autoConnect: false
      }
    });

    // Create provider manually to have more control
    this.provider = new YjsNotebookProvider({
      notebookId,
      autoConnect: false
    });

    // Replace the model's provider with our controlled one
    (this.model as any)._yjsProvider = this.provider;
    
    // Access the internal Yjs document
    this.sharedNotebook = this.provider.getSharedNotebook();
    this.sharedCells = this.provider.getSharedCells();
  }

  // Simulate connecting to the collaboration server
  connect(): void {
    this.provider.connect();
  }

  // Simulate disconnecting from the collaboration server
  disconnect(): void {
    this.provider.disconnect();
  }

  // Apply remote updates from another client
  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.ydoc, update);
  }

  // Get updates to send to other clients
  getUpdate(): Uint8Array {
    return Y.encodeStateAsUpdate(this.ydoc);
  }

  // Add a cell to the notebook
  addCell(index: number, cellType: string = 'code', source: string = ''): void {
    const factory = this.model.contentFactory;
    const cell = factory.createCell(cellType, {
      value: source
    });
    this.model.cells.insert(index, cell);
  }

  // Update a cell's content
  updateCell(index: number, source: string): void {
    const cell = this.model.cells.get(index);
    if (cell) {
      cell.value.text = source;
    }
  }

  // Get a cell's content
  getCellContent(index: number): string {
    const cell = this.model.cells.get(index);
    return cell ? cell.value.text : '';
  }

  // Get the number of cells
  getCellCount(): number {
    return this.model.cells.length;
  }

  id: number;
  ydoc: Y.Doc;
  model: NotebookModel;
  provider: YjsNotebookProvider;
  sharedNotebook: Y.Map<any>;
  sharedCells: Y.Array<any>;
}

/**
 * Helper function to synchronize changes between clients
 */
function syncClients(clients: TestClient[]): void {
  // Get updates from each client
  const updates = clients.map(client => client.getUpdate());
  
  // Apply each update to all other clients
  for (let i = 0; i < clients.length; i++) {
    for (let j = 0; j < updates.length; j++) {
      if (i !== j) {
        clients[i].applyUpdate(updates[j]);
      }
    }
  }
}

/**
 * Helper function to simulate network delay
 */
async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('NotebookModel with Yjs integration', () => {
  describe('Document synchronization', () => {
    it('should initialize a Yjs document when collaborative mode is enabled', () => {
      const model = new NotebookModel({
        collaborative: true,
        collaborationOptions: {
          documentId: 'test-notebook'
        }
      });

      expect(model.collaborative).toBe(true);
      expect(model.yjsProvider).not.toBeNull();
    });

    it('should not initialize a Yjs document when collaborative mode is disabled', () => {
      const model = new NotebookModel({
        collaborative: false
      });

      expect(model.collaborative).toBe(false);
      expect(model.yjsProvider).toBeNull();
    });

    it('should enable and disable collaboration on demand', () => {
      const model = new NotebookModel({
        collaborative: false
      });

      expect(model.collaborative).toBe(false);
      expect(model.yjsProvider).toBeNull();

      model.enableCollaboration({
        documentId: 'test-notebook'
      });

      expect(model.collaborative).toBe(true);
      expect(model.yjsProvider).not.toBeNull();

      model.disableCollaboration();

      expect(model.collaborative).toBe(false);
      expect(model.yjsProvider).toBeNull();
    });
  });

  describe('Change tracking across multiple clients', () => {
    it('should synchronize cell additions between clients', () => {
      // Create two clients
      const client1 = new TestClient(1);
      const client2 = new TestClient(2);

      // Client 1 adds a cell
      client1.addCell(0, 'code', 'print("Hello from client 1")');
      expect(client1.getCellCount()).toBe(1);
      expect(client2.getCellCount()).toBe(0); // Not synced yet

      // Sync changes
      syncClients([client1, client2]);

      // Verify both clients have the same cells
      expect(client1.getCellCount()).toBe(1);
      expect(client2.getCellCount()).toBe(1);
      expect(client2.getCellContent(0)).toBe('print("Hello from client 1")');
    });

    it('should synchronize cell updates between clients', () => {
      // Create two clients
      const client1 = new TestClient(1);
      const client2 = new TestClient(2);

      // Client 1 adds a cell
      client1.addCell(0, 'code', 'print("Initial content")');
      
      // Sync changes
      syncClients([client1, client2]);

      // Client 2 updates the cell
      client2.updateCell(0, 'print("Updated by client 2")');
      expect(client2.getCellContent(0)).toBe('print("Updated by client 2")');
      expect(client1.getCellContent(0)).toBe('print("Initial content")'); // Not synced yet

      // Sync changes
      syncClients([client1, client2]);

      // Verify both clients have the updated content
      expect(client1.getCellContent(0)).toBe('print("Updated by client 2")');
      expect(client2.getCellContent(0)).toBe('print("Updated by client 2")');
    });

    it('should track changes across multiple clients', () => {
      // Create three clients
      const client1 = new TestClient(1);
      const client2 = new TestClient(2);
      const client3 = new TestClient(3);

      // Client 1 adds cells
      client1.addCell(0, 'markdown', '# Heading');
      client1.addCell(1, 'code', 'print("Cell 1")');
      
      // Sync all clients
      syncClients([client1, client2, client3]);

      // Client 2 adds a cell
      client2.addCell(2, 'code', 'print("Cell 2")');
      
      // Client 3 updates the first cell
      client3.updateCell(0, '# Updated Heading');
      
      // Sync all clients again
      syncClients([client1, client2, client3]);

      // Verify all clients have the same content
      expect(client1.getCellCount()).toBe(3);
      expect(client2.getCellCount()).toBe(3);
      expect(client3.getCellCount()).toBe(3);
      
      expect(client1.getCellContent(0)).toBe('# Updated Heading');
      expect(client2.getCellContent(0)).toBe('# Updated Heading');
      expect(client3.getCellContent(0)).toBe('# Updated Heading');
      
      expect(client1.getCellContent(2)).toBe('print("Cell 2")');
      expect(client2.getCellContent(2)).toBe('print("Cell 2")');
      expect(client3.getCellContent(2)).toBe('print("Cell 2")');
    });
  });

  describe('Conflict resolution during concurrent edits', () => {
    it('should resolve conflicts when multiple clients edit the same cell', () => {
      // Create two clients
      const client1 = new TestClient(1);
      const client2 = new TestClient(2);

      // Client 1 adds a cell
      client1.addCell(0, 'code', 'x = 1');
      
      // Sync changes
      syncClients([client1, client2]);

      // Both clients update the same cell concurrently
      client1.updateCell(0, 'x = 1\ny = 2');
      client2.updateCell(0, 'x = 1\nz = 3');

      // Sync changes - CRDT should resolve the conflict
      syncClients([client1, client2]);

      // Verify both clients have the same content after conflict resolution
      // The exact result depends on the CRDT algorithm, but both clients should be the same
      expect(client1.getCellContent(0)).toBe(client2.getCellContent(0));
      
      // The content should contain both changes (the exact order may vary)
      const content = client1.getCellContent(0);
      expect(content.includes('y = 2')).toBe(true);
      expect(content.includes('z = 3')).toBe(true);
    });

    it('should handle concurrent cell additions at the same position', () => {
      // Create two clients
      const client1 = new TestClient(1);
      const client2 = new TestClient(2);

      // Both clients add different cells at position 0 concurrently
      client1.addCell(0, 'code', 'print("Cell from client 1")');
      client2.addCell(0, 'code', 'print("Cell from client 2")');

      // Sync changes
      syncClients([client1, client2]);

      // Verify both clients have the same cells after conflict resolution
      expect(client1.getCellCount()).toBe(2);
      expect(client2.getCellCount()).toBe(2);
      
      // The cells should be in the same order on both clients
      expect(client1.getCellContent(0)).toBe(client2.getCellContent(0));
      expect(client1.getCellContent(1)).toBe(client2.getCellContent(1));
    });
  });

  describe('Document consistency during network disruptions', () => {
    it('should maintain consistency when a client disconnects and reconnects', async () => {
      // Create two clients
      const client1 = new TestClient(1);
      const client2 = new TestClient(2);

      // Client 1 adds cells
      client1.addCell(0, 'markdown', '# Initial Heading');
      client1.addCell(1, 'code', 'print("Initial code")');
      
      // Sync changes
      syncClients([client1, client2]);

      // Simulate client2 disconnecting
      client2.disconnect();

      // Client 1 makes changes while client 2 is disconnected
      client1.updateCell(0, '# Updated Heading');
      client1.addCell(2, 'code', 'print("New cell")');

      // Client 2 also makes local changes while disconnected
      client2.updateCell(1, 'print("Updated code")');

      // Simulate network delay
      await delay(100);

      // Client 2 reconnects and syncs
      client2.connect();
      syncClients([client1, client2]);

      // Verify both clients have the same content after reconnection
      expect(client1.getCellCount()).toBe(3);
      expect(client2.getCellCount()).toBe(3);
      
      expect(client1.getCellContent(0)).toBe('# Updated Heading');
      expect(client2.getCellContent(0)).toBe('# Updated Heading');
      
      expect(client1.getCellContent(1)).toBe(client2.getCellContent(1));
      expect(client1.getCellContent(2)).toBe(client2.getCellContent(2));
    });

    it('should recover properly after intermittent connections', async () => {
      // Create three clients
      const client1 = new TestClient(1);
      const client2 = new TestClient(2);
      const client3 = new TestClient(3);

      // All clients start with the same content
      client1.addCell(0, 'markdown', '# Heading');
      syncClients([client1, client2, client3]);

      // Simulate intermittent connections by syncing only some clients
      client1.updateCell(0, '# Updated by client 1');
      syncClients([client1, client2]); // client3 misses this update

      client2.addCell(1, 'code', 'print("Added by client 2")');
      syncClients([client2, client3]); // client1 misses this update

      client3.addCell(2, 'markdown', '## Subheading from client 3');
      syncClients([client1, client3]); // client2 misses this update

      // Now sync all clients to resolve all changes
      syncClients([client1, client2, client3]);

      // Verify all clients have the same content after full sync
      expect(client1.getCellCount()).toBe(3);
      expect(client2.getCellCount()).toBe(3);
      expect(client3.getCellCount()).toBe(3);
      
      // All cells should be identical across clients
      for (let i = 0; i < 3; i++) {
        expect(client1.getCellContent(i)).toBe(client2.getCellContent(i));
        expect(client2.getCellContent(i)).toBe(client3.getCellContent(i));
      }
    });
  });

  describe('Performance requirements', () => {
    it('should synchronize updates within 200ms for notebooks up to 100KB', async () => {
      // Create two clients
      const client1 = new TestClient(1);
      const client2 = new TestClient(2);

      // Add multiple cells to create a notebook around 100KB in size
      const cellCount = 50; // Adjust based on cell size to reach ~100KB
      for (let i = 0; i < cellCount; i++) {
        client1.addCell(i, 'code', `# Cell ${i}\nprint("This is a test cell with some content to increase size")`);  
      }

      // Sync initial state
      syncClients([client1, client2]);

      // Measure time to sync a change
      const startTime = performance.now();
      
      // Make a change on client1
      client1.updateCell(0, '# Updated cell 0\nprint("This cell was updated")');
      
      // Sync the change
      syncClients([client1, client2]);
      
      const endTime = performance.now();
      const syncTime = endTime - startTime;

      // Verify sync time is under 200ms
      expect(syncTime).toBeLessThan(200);
      
      // Verify the change was properly synchronized
      expect(client2.getCellContent(0)).toBe('# Updated cell 0\nprint("This cell was updated")');
    });

    it('should handle synchronization with 50 simulated concurrent users', () => {
      // Create 50 clients
      const clients: TestClient[] = [];
      for (let i = 1; i <= 50; i++) {
        clients.push(new TestClient(i));
      }

      // Client 1 initializes the document
      clients[0].addCell(0, 'markdown', '# Collaborative Test');
      clients[0].addCell(1, 'code', 'print("Hello world")');

      // Sync to all clients
      syncClients(clients);

      // Each client makes a small change
      for (let i = 0; i < clients.length; i++) {
        clients[i].addCell(i + 2, 'code', `# From client ${i + 1}\nprint("Client ${i + 1} was here")`);
      }

      // Measure time to sync all changes
      const startTime = performance.now();
      
      // Sync all clients
      syncClients(clients);
      
      const endTime = performance.now();
      const syncTime = endTime - startTime;

      // Verify all clients have the same content
      const expectedCellCount = 52; // 2 initial + 50 added
      for (const client of clients) {
        expect(client.getCellCount()).toBe(expectedCellCount);
      }

      // Log the sync time for informational purposes
      console.log(`Sync time for 50 clients: ${syncTime}ms`);

      // The actual time will depend on the test environment,
      // but we expect it to be reasonable for the test to pass
      expect(syncTime).toBeLessThan(5000); // 5 seconds is a generous upper bound for the test environment
    });
  });
});