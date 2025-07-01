# What to do when things go wrong

First, have a look at the common problems listed below. If you can figure it out
from these notes, it will be quicker than asking for help.

Check that you have the latest version of any packages that look relevant.
Unfortunately it's not always easy to figure out what packages are relevant,
but if there was a bug that's already been fixed,
it's easy to upgrade and get on with what you wanted to do.

## Jupyter fails to start

- Have you [installed it](https://jupyter.org/install.html)? ;-)
- If you're using a menu shortcut or Anaconda launcher to start it, try
  opening a terminal or command prompt and running the command `jupyter notebook`.
- If it can't find `jupyter`,
  you may need to configure your `PATH` environment variable.
  If you don't know what that means, and don't want to find out,
  just (re)install Anaconda with the default settings,
  and it should set up PATH correctly.
- If Jupyter gives an error that it can't find `notebook`,
  check with pip or conda that the `notebook` package is installed.
- Try running `jupyter-notebook` (with a hyphen). This should normally be the
  same as `jupyter notebook` (with a space), but if there's any difference,
  the version with the hyphen is the 'real' launcher, and the other one wraps
  that.

## Jupyter doesn't load or doesn't work in the browser

- Try in another browser (e.g. if you normally use Firefox, try with Chrome).
  This helps pin down where the problem is.
- Try disabling any browser extensions and/or any Jupyter extensions you have
  installed.
- Some internet security software can interfere with Jupyter.
  If you have security software, try turning it off temporarily,
  and look in the settings for a more long-term solution.
- In the address bar, try changing between `localhost` and `127.0.0.1`.
  They should be the same, but in some cases it makes a difference.

## Jupyter can't start a kernel

Files called _kernel specs_ tell Jupyter how to start different kinds of kernels.
To see where these are on your system, run `jupyter kernelspec list`:

```
$ jupyter kernelspec list
Available kernels:
  python3      /home/takluyver/.local/lib/python3.6/site-packages/ipykernel/resources
  bash         /home/takluyver/.local/share/jupyter/kernels/bash
  ir           /home/takluyver/.local/share/jupyter/kernels/ir
```

There's a special fallback for the Python kernel:
if it doesn't find a real kernelspec, but it can import the `ipykernel` package,
it provides a kernel which will run in the same Python environment as the notebook server.
A path ending in `ipykernel/resources`, like in the example above,
is this default kernel.
The default often does what you want,
so if the `python3` kernelspec points somewhere else
and you can't start a Python kernel,
try deleting or renaming that kernelspec folder to expose the default.

If your problem is with another kernel, not the Python one we maintain,
you may need to look for support about that kernel.

## Python Environments

Multiple python environments, whether based on Anaconda or Python Virtual environments,
are often the source of reported issues. In many cases, these issues stem from the
Notebook server running in one environment, while the kernel and/or its resources,
derive from another environment. Indicators of this scenario include:

- `import` statements within code cells producing `ImportError` or `ModuleNotFound` exceptions.
- General kernel startup failures exhibited by nothing happening when attempting
  to execute a cell.

In these situations, take a close look at your environment structure and ensure all
packages required by your notebook's code are installed in the correct environment.
If you need to run the kernel from different environments than your Notebook
server, check out [IPython's documentation](https://ipython.readthedocs.io/en/stable/install/kernel_install.html#kernels-for-different-environments)
for using kernels from different environments as this is the recommended approach.
Anaconda's [nb_conda_kernels](https://github.com/Anaconda-Platform/nb_conda_kernels)
package might also be an option for you in these scenarios.

Another thing to check is the `kernel.json` file that will be located in the
aforementioned _kernel specs_ directory identified by running `jupyter kernelspec list`.
This file will contain an `argv` stanza that includes the actual command to run
when launching the kernel. Oftentimes, when reinstalling python environments, a previous
`kernel.json` will reference an python executable from an old or non-existent location.
As a result, it's always a good idea when encountering kernel startup issues to validate
the `argv` stanza to ensure all file references exist and are appropriate.

## Windows Systems

Although Jupyter Notebook is primarily developed on the various flavors of the Unix
operating system it also supports Microsoft
Windows - which introduces its own set of commonly encountered issues,
particularly in the areas of security, process management and lower-level libraries.

### pywin32 Issues

The primary package for interacting with Windows' primitives is `pywin32`.

- Issues surrounding the creation of the kernel's communication file utilize
  `jupyter_core`'s `secure_write()` function. This function ensures a file is
  created in which only the owner of the file has access. If libraries like `pywin32`
  are not properly installed, issues can arise when it's necessary to use the native
  Windows libraries.

  Here's a portion of such a traceback:

  ```
  File "c:\users\jovyan\python\myenv.venv\lib\site-packages\jupyter_core\paths.py", line 424, in secure_write
  win32_restrict_file_to_user(fname)
  File "c:\users\jovyan\python\myenv.venv\lib\site-packages\jupyter_core\paths.py", line 359, in win32_restrict_file_to_user
  import win32api
  ImportError: DLL load failed: The specified module could not be found.
  ```

- As noted earlier, the installation of `pywin32` can be problematic on Windows
  configurations. When such an issue occurs, you may need to revisit how the environment
  was setup. Pay careful attention to whether you're running the 32 or 64 bit versions
  of Windows and be sure to install appropriate packages for that environment.

  Here's a portion of such a traceback:

  ```
  File "C:\Users\jovyan\AppData\Roaming\Python\Python37\site-packages\jupyter_core\paths.py", line 435, in secure_write
  win32_restrict_file_to_user(fname)
  File "C:\Users\jovyan\AppData\Roaming\Python\Python37\site-packages\jupyter_core\paths.py", line 361, in win32_restrict_file_to_user
  import win32api
  ImportError: DLL load failed: %1 is not a valid Win32 application
  ```

#### Resolving pywin32 Issues

> In this case, your `pywin32` module may not be installed correctly and the following
> should be attempted:
>
> ```
> pip install --upgrade pywin32
> ```
>
> or:
>
> ```
> conda install --force-reinstall pywin32
> ```
>
> followed by:
>
> ```
> python.exe Scripts/pywin32_postinstall.py -install
> ```
>
> where `Scripts` is located in the active Python's installation location.

- Another common failure specific to Windows environments is the location of various
  python commands. On `*nix` systems, these typically reside in the `bin` directory
  of the active Python environment. However, on Windows, these tend to reside in the
  `Scripts` folder - which is a sibling to `bin`. As a result, when encountering
  kernel startup issues, again, check the `argv` stanza and verify it's pointing to a
  valid file. You may find that it's pointing in `bin` when `Scripts` is correct, or
  the referenced file does not include its `.exe` extension - typically resulting in
  `FileNotFoundError` exceptions.

## This Worked An Hour Ago

The Jupyter stack is very complex and rightfully so, there's a lot going on. On occasion
you might find the system working perfectly well, then, suddenly, you can't get past a
certain cell due to `import` failures. In these situations, it's best to ask yourself
if any new python files were added to your notebook development area.

These issues are usually evident by carefully analyzing the traceback produced in
the notebook error or the Notebook server's command window. In these cases, you'll typically
find the Python kernel code (from `IPython` and `ipykernel`) performing _its_ imports
and notice a file from your Notebook development error included in that traceback followed
by an `AttributeError`:

```
File "C:\Users\jovyan\anaconda3\lib\site-packages\ipykernel\connect.py", line 13, in
from IPython.core.profiledir import ProfileDir
File "C:\Users\jovyan\anaconda3\lib\site-packages\IPython_init.py", line 55, in
from .core.application import Application
...
File "C:\Users\jovyan\anaconda3\lib\site-packages\ipython_genutils\path.py", line 13, in
import random
File "C:\Users\jovyan\Desktop\Notebooks\random.py", line 4, in
rand_set = random.sample(english_words_lower_set, 12)
AttributeError: module 'random' has no attribute 'sample'
```

What has happened is that you have named a file that conflicts with an installed package
that is used by the kernel software and now introduces a conflict preventing the
kernel's startup.

**Resolution**: You'll need to rename your file. A best practice would be to prefix or
_namespace_ your files so as not to conflict with any python package.

## Asking for help

As with any problem, try searching to see if someone has already found an answer.
If you can't find an existing answer, you can ask questions at:

- The [Jupyter Discourse Forum](https://discourse.jupyter.org/)

- The [jupyter-notebook tag on Stackoverflow](https://stackoverflow.com/questions/tagged/jupyter-notebook)

- Peruse the [jupyter/help repository on Github](https://github.com/jupyter/help) (read-only)

- Or in an issue on another repository, if it's clear which component is
  responsible. Typical repositories include:

  > - [jupyter_core](https://github.com/jupyter/jupyter_core) - `secure_write()`
  >   and file path issues
  > - [jupyter_client](https://github.com/jupyter/jupyter_core) - kernel management
  >   issues found in Notebook server's command window.
  > - [IPython](https://github.com/ipython/ipython) and
  >   [ipykernel](https://github.com/ipython/ipykernel) - kernel runtime issues
  >   typically found in Notebook server's command window and/or Notebook cell execution.

### Gathering Information

Should you find that your problem warrants that an issue be opened in
[notebook](https://github.com/jupyter/notebook) please don't forget to provide details
like the following:

- What error messages do you see (within your notebook and, more importantly, in
  the Notebook server's command window)?
- What platform are you on?
- How did you install Jupyter?
- What have you tried already?

The `jupyter troubleshoot` command collects a lot of information
about your installation, which can also be useful.

When providing textual information, it's most helpful if you can _scrape_ the contents
into the issue rather than providing a screenshot. This enables others to select
pieces of that content so they can search more efficiently and try to help.

Remember that it's not anyone's job to help you.
We want Jupyter to work for you,
but we can't always help everyone individually.

## Collaboration Features Troubleshooting

This section covers troubleshooting for Jupyter Notebook v7's real-time collaborative editing features, including WebSocket connectivity issues, permission conflicts, cell locking problems, and service degradation scenarios.

### Collaboration Service Issues

#### Collaboration features are not available

**Symptoms:**
- Collaboration toolbar is missing from notebook interface
- No presence indicators for other users
- Unable to see real-time changes from collaborators
- "Collaboration not available" message appears

**Common Causes and Solutions:**

1. **Collaboration service disabled:**
   - Check if the `COLLAB_DISABLED` environment variable is set to `true`
   - Verify your deployment configuration allows collaborative features
   - In single-user installations, collaboration is disabled by default

2. **Missing dependencies:**
   ```bash
   # Check if required collaboration packages are installed
   pip list | grep -E "(yjs|jupyter-collaboration)"
   
   # Install missing dependencies
   pip install jupyter-collaboration
   # or for conda
   conda install jupyter-collaboration -c conda-forge
   ```

3. **Service configuration:**
   ```bash
   # Check if collaboration extension is enabled
   jupyter server extension list
   
   # Enable collaboration extension if missing
   jupyter server extension enable jupyter_collaboration
   ```

#### WebSocket Connection Failures

**Symptoms:**
- "Connection lost" warnings in notebook interface
- Changes not syncing between users
- Frequent reconnection attempts
- Network errors in browser console

**Diagnostic Steps:**

1. **Check WebSocket connectivity:**
   ```bash
   # Test WebSocket endpoint (replace with your server URL)
   wscat -c "wss://your-jupyter-server.com/_yws"
   
   # Or using curl to test HTTP upgrade
   curl -i -N -H "Connection: Upgrade" \
        -H "Upgrade: websocket" \
        -H "Sec-WebSocket-Key: test" \
        -H "Sec-WebSocket-Version: 13" \
        https://your-server.com/_yws
   ```

2. **Verify server configuration:**
   ```python
   # Check Jupyter server configuration
   from jupyter_server.serverapp import ServerApp
   app = ServerApp()
   print(f"Base URL: {app.base_url}")
   print(f"WebSocket ping interval: {app.websocket_ping_interval}")
   print(f"WebSocket ping timeout: {app.websocket_ping_timeout}")
   ```

3. **Browser network diagnostics:**
   - Open browser developer tools (F12)
   - Go to Network tab and filter for "WS" (WebSocket)
   - Look for failed connections or frequent disconnections
   - Check for CORS errors or authentication failures

**Common Solutions:**

1. **Proxy configuration issues:**
   ```nginx
   # Nginx configuration for WebSocket support
   location /_yws {
       proxy_pass http://jupyter-backend;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_read_timeout 86400;
   }
   ```

2. **Firewall and network issues:**
   - Ensure WebSocket traffic is allowed through firewalls
   - Check if network implements WebSocket blocking
   - Verify TLS certificates are valid for WebSocket connections

3. **Authentication problems:**
   ```bash
   # Check server logs for authentication errors
   tail -f ~/.jupyter/jupyter_server_config.py
   
   # Verify token-based authentication is working
   jupyter server list
   ```

#### Connection Recovery Procedures

When WebSocket connections fail, the system implements automatic recovery:

1. **Automatic reconnection:**
   - System attempts reconnection with exponential backoff
   - Changes are queued locally during disconnection
   - Automatic sync occurs when connection is restored

2. **Manual recovery steps:**
   ```bash
   # Force browser to reconnect
   # In browser console:
   window.location.reload();
   
   # Or use notebook menu: File → Reload Notebook
   ```

3. **Server-side recovery:**
   ```bash
   # Restart collaboration service
   systemctl restart jupyter-collaboration
   
   # Or restart entire Jupyter server
   systemctl restart jupyter-server
   ```

### Permission and Access Control Issues

#### Permission Denied Errors

**Symptoms:**
- "Permission denied" messages when editing cells
- Inability to execute code despite being in notebook
- Missing edit controls or grayed-out interface elements
- User switched to read-only mode unexpectedly

**Diagnostic Commands:**

1. **Check user permissions:**
   ```python
   # In a notebook cell, check current user and permissions
   import os
   import requests
   
   # Get current user info
   user_info = requests.get('/user').json() if hasattr(requests, 'get') else None
   print(f"Current user: {os.environ.get('JUPYTERHUB_USER', 'local-user')}")
   
   # Check notebook metadata for collaboration permissions
   # Look in notebook metadata: "collaboration": {"permissions": {...}}
   ```

2. **Server-side permission check:**
   ```bash
   # Check server logs for permission-related errors
   journalctl -u jupyter-server -f | grep -i "permission\|auth\|collab"
   
   # Verify JupyterHub token is valid (if using JupyterHub)
   curl -H "Authorization: token $JUPYTERHUB_API_TOKEN" \
        https://your-hub.com/hub/api/user
   ```

**Common Solutions:**

1. **Role-based access control:**
   - Verify user has appropriate role (view/edit/admin)
   - Check with notebook owner or administrator about permissions
   - Ensure JupyterHub group memberships are correct

2. **Authentication token issues:**
   ```bash
   # Refresh authentication token
   # Logout and login again to JupyterHub
   
   # Or restart notebook server to refresh tokens
   jupyter server stop && jupyter server start
   ```

3. **Configuration problems:**
   ```python
   # Check collaboration configuration
   from jupyter_server.serverapp import ServerApp
   app = ServerApp()
   print(f"Collaboration enabled: {getattr(app, 'collaboration_enabled', False)}")
   ```

#### Multi-user Environment Conflicts

**Common scenarios and resolution:**

1. **Conflicting user roles:**
   - **Problem:** User has view-only access but expects to edit
   - **Solution:** Contact notebook owner to upgrade permissions
   - **Diagnostic:** Check notebook metadata for permission settings

2. **Session conflicts:**
   - **Problem:** Multiple sessions for same user causing conflicts
   - **Solution:** Close duplicate browser tabs/sessions
   - **Diagnostic:** Check active sessions in JupyterHub admin panel

3. **Group permission inheritance:**
   - **Problem:** User permissions not reflecting group membership changes
   - **Solution:** Restart user server to refresh group memberships
   - **Command:** In JupyterHub admin: stop and restart user server

### Cell Locking Issues

#### Cell Lock Timeout Scenarios

**Symptoms:**
- Cannot edit cell showing "locked by another user"
- Lock persists after user disconnection
- "Lock acquisition timeout" errors
- Cells remain locked indefinitely

**Automatic Recovery Mechanisms:**

1. **Lock timeout handling:**
   - Automatic lock release after 5 minutes of inactivity
   - Lock cleanup when user disconnects
   - Force unlock available to administrators

2. **Manual lock recovery:**
   ```javascript
   // In browser console, force unlock a cell (admin only)
   // First, get the cell ID from the notebook interface
   const cellId = 'cell-id-here';
   
   // Access collaboration manager
   const collabManager = window.app?.shell?.currentWidget?.context?.model?.collaborationManager;
   if (collabManager) {
       collabManager.forceLockRelease(cellId);
   }
   ```

3. **Server-side lock cleanup:**
   ```bash
   # Clean up stale locks (requires server admin access)
   curl -X POST -H "Authorization: token $ADMIN_TOKEN" \
        "https://your-server.com/api/collaboration/cleanup-locks"
   ```

#### Lock Conflict Resolution

**When multiple users attempt to edit the same cell:**

1. **Expected behavior:**
   - First user acquires lock automatically
   - Subsequent users see lock conflict message
   - Visual indicator shows which user has the lock

2. **If conflicts persist:**
   ```bash
   # Check for distributed lock synchronization issues
   # Look for errors in server logs
   grep -i "lock.*conflict\|yjs.*error" /var/log/jupyter/*.log
   
   # Restart collaboration service to reset lock state
   systemctl restart jupyter-collaboration
   ```

3. **Lock debugging:**
   ```python
   # In notebook, check lock state (admin only)
   from jupyter_collaboration.yjs_websocket_handler import YjsWebSocketHandler
   handler = YjsWebSocketHandler.get_current_handler()
   if handler:
       print(f"Active locks: {handler.get_active_locks()}")
   ```

### Graceful Degradation Issues

#### When Collaboration Server is Unavailable

**Symptoms:**
- Notebook loads but collaboration features are disabled
- "Working in single-user mode" notification
- No presence indicators or real-time sync
- All collaborative UI elements hidden

**Expected Behavior:**
- Notebook functions normally in single-user mode
- All non-collaborative features remain fully functional
- No data loss or functionality degradation
- Automatic reconnection attempts when service becomes available

**Troubleshooting Degradation:**

1. **Check service status:**
   ```bash
   # Verify collaboration service is running
   systemctl status jupyter-collaboration
   
   # Check for service startup errors
   journalctl -u jupyter-collaboration --since "10 minutes ago"
   
   # Test collaboration endpoint availability
   curl -f https://your-server.com/_yws/health || echo "Service unavailable"
   ```

2. **Network connectivity:**
   ```bash
   # Test connectivity to collaboration service
   telnet your-collaboration-server.com 443
   
   # Check DNS resolution for collaboration endpoints
   nslookup your-collaboration-server.com
   ```

3. **Configuration validation:**
   ```python
   # Verify graceful degradation is properly configured
   import jupyter_server
   config = jupyter_server.serverapp.ServerApp().config
   collab_config = config.get('CollaborationApp', {})
   print(f"Fallback enabled: {collab_config.get('enable_fallback', True)}")
   ```

#### Service Recovery Procedures

**When collaboration service becomes available again:**

1. **Automatic reconnection:**
   - Browser automatically detects service availability
   - Reconnection attempt every 30 seconds
   - Success notification when collaborative mode resumes

2. **Manual reconnection:**
   ```javascript
   // Force immediate reconnection attempt
   // In browser console:
   if (window.app?.collaborationManager) {
       window.app.collaborationManager.reconnect();
   }
   ```

3. **Full service restart:**
   ```bash
   # Restart all collaboration components
   systemctl restart jupyter-collaboration
   systemctl restart jupyter-server
   
   # Verify services are healthy
   curl https://your-server.com/_yws/health
   ```

### Diagnostic Commands and Configuration Checks

#### YjsWebSocketHandler Status

**Check handler status:**
```bash
# View active WebSocket connections
ss -tuln | grep :8888  # Replace 8888 with your Jupyter port

# Check handler process status
ps aux | grep -i yjs

# Monitor real-time connections
netstat -an | grep ESTABLISHED | grep :8888
```

**Server configuration verification:**
```python
# Check Yjs configuration
from jupyter_server.serverapp import ServerApp
from jupyter_collaboration import YjsWebSocketHandler

app = ServerApp()
print(f"WebSocket handlers: {app.websocket_handlers}")
print(f"Yjs enabled: {'yjs' in str(app.websocket_handlers)}")

# Verify collaboration extension status
import jupyter_collaboration
print(f"Collaboration version: {jupyter_collaboration.__version__}")
```

#### Collaboration Service Health Checks

**Service health endpoints:**
```bash
# Basic health check
curl -f https://your-server.com/_yws/health

# Detailed status information
curl -H "Authorization: token $JUPYTER_TOKEN" \
     https://your-server.com/api/collaboration/status

# WebSocket connection test
wscat -c "wss://your-server.com/_yws" -H "Authorization: token $JUPYTER_TOKEN"
```

**Performance monitoring:**
```bash
# Monitor WebSocket connection counts
curl -s https://your-server.com/_yws/metrics | grep ws_connections

# Check collaboration document count
curl -s https://your-server.com/_yws/metrics | grep active_documents

# Memory usage by collaboration service
ps -o pid,ppid,cmd,%mem,%cpu --sort=-%mem | grep -i yjs
```

#### Log Analysis Commands

**Server logs:**
```bash
# View collaboration-specific logs
journalctl -u jupyter-server | grep -i "collab\|yjs\|websocket"

# Monitor real-time collaboration events
tail -f /var/log/jupyter/collaboration.log

# Check for WebSocket errors
grep -E "WebSocket.*error|Connection.*failed" /var/log/jupyter/*.log
```

**Client-side debugging:**
```javascript
// Enable debug logging in browser console
localStorage.setItem('debug', 'jupyter:collaboration:*');
location.reload();

// Check collaboration manager status
console.log(window.app?.collaborationManager?.status);

// View active collaborative sessions
console.log(window.app?.collaborationManager?.activeSessions);
```

#### Configuration File Checks

**Jupyter server configuration:**
```bash
# Locate and check main configuration
find ~/.jupyter /etc/jupyter -name "*config*.py" -exec echo "=== {} ===" \; -exec cat {} \;

# Verify collaboration extension configuration
grep -r "collaboration" ~/.jupyter/ /etc/jupyter/

# Check environment variables affecting collaboration
env | grep -i "COLLAB\|YJS\|JUPYTER"
```

**Collaboration-specific settings:**
```python
# Check current collaboration configuration
from traitlets.config import Application
config = Application.instance().config

# View collaboration settings
collab_config = config.get('YjsWebSocketHandler', {})
for key, value in collab_config.items():
    print(f"{key}: {value}")

# Check for conflicting configuration
import jupyter_collaboration
print(f"Configuration file: {jupyter_collaboration.__file__}")
```

### Performance Issues During Collaboration

#### High Latency in Real-time Sync

**Symptoms:**
- Changes take more than 100ms to appear for other users
- Typing lag during collaborative editing
- Slow cursor position updates

**Diagnostic steps:**
```bash
# Check server resource usage
top -p $(pgrep -f "jupyter.*collaboration")

# Monitor network latency
ping -c 10 your-collaboration-server.com

# Check WebSocket message timing
# In browser console:
performance.mark('collab-start');
// ... perform collaborative action ...
performance.mark('collab-end');
performance.measure('collab-latency', 'collab-start', 'collab-end');
```

#### Memory Usage Issues

**High memory consumption:**
```bash
# Check memory usage by collaboration processes
ps -o pid,ppid,cmd,%mem --sort=-%mem | grep -E "jupyter|yjs"

# Monitor memory growth over time
watch -n 5 'ps -o pid,ppid,cmd,%mem --sort=-%mem | grep jupyter'

# Check for memory leaks in browser
# Browser console:
console.log(performance.memory);
```

### Getting Help for Collaboration Issues

When reporting collaboration-related problems, include:

1. **System information:**
   ```bash
   jupyter --version
   jupyter server extension list
   pip list | grep -E "(jupyter|yjs|collaboration)"
   ```

2. **Collaboration-specific details:**
   - Number of concurrent users when issue occurred
   - Network connectivity type (local, VPN, cloud)
   - Browser and version used
   - Whether issue occurs in single-user mode

3. **Error logs:**
   ```bash
   # Collect relevant logs
   journalctl -u jupyter-server --since "1 hour ago" > jupyter-server.log
   journalctl -u jupyter-collaboration --since "1 hour ago" > jupyter-collab.log
   ```

4. **Configuration:**
   ```bash
   # Export configuration for review
   jupyter server --generate-config
   cat ~/.jupyter/jupyter_server_config.py
   ```

For collaboration-specific issues, you can also reach out to:
- [JupyterLab Collaboration GitHub Issues](https://github.com/jupyterlab/jupyter-collaboration/issues)
- [Jupyter Community Forum - Collaboration category](https://discourse.jupyter.org/c/jupyterlab/collaboration)

When reporting WebSocket connection issues, include network topology information and any proxy/load balancer configurations that might affect WebSocket connectivity.
