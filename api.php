<?php
// Create a local session directory to isolate our sessions from XAMPP's aggressive global garbage collector
$sessionPath = __DIR__ . '/sessions';
if (!is_dir($sessionPath)) {
    @mkdir($sessionPath, 0777, true);
}
session_save_path($sessionPath);

// Tell the server to keep session files alive for 30 days
ini_set('session.gc_maxlifetime', 2592000);

// Make session persistent for 30 days so PWA users stay logged in across restarts
session_set_cookie_params([
    'lifetime' => 2592000,
    'path' => '/',
    'samesite' => 'Lax'
]);
session_start();
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

// --- Configuration ---
// The root path to the NAS device. Ensure the user running XAMPP has permissions to this network share.
define('NAS_ROOT', '\\\\192.168.100.66\\c');
define('DB_FILE', __DIR__ . '/kamatayan_auth.sqlite');

// --- Helper Functions ---
function respond($status, $data = [], $message = '') {
    echo json_encode(['status' => $status, 'data' => $data, 'message' => $message]);
    exit;
}

function sanitizePath($path) {
    // Prevent directory traversal
    $path = str_replace(['../', '..\\'], '', $path);
    return ltrim($path, '/\\');
}

function getFullPath($relativePath) {
    $safePath = sanitizePath($relativePath);
    if ($safePath === '') {
        return NAS_ROOT;
    }
    return NAS_ROOT . DIRECTORY_SEPARATOR . $safePath;
}

// --- Database & Auth Initialization ---
try {
    $db = new PDO('sqlite:' . DB_FILE);
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

    // Create users table if it doesn't exist
    $db->exec("CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password_hash TEXT,
        role TEXT
    )");

    // Create default admin if no users exist
    $stmt = $db->query("SELECT COUNT(*) FROM users");
    if ($stmt->fetchColumn() == 0) {
        $hash = password_hash('admin', PASSWORD_DEFAULT);
        $db->exec("INSERT INTO users (username, password_hash, role) VALUES ('admin', '$hash', 'admin')");
    }
} catch (PDOException $e) {
    respond('error', [], 'Database error: ' . $e->getMessage());
}

// --- Action Routing ---
$action = $_GET['action'] ?? '';

// Unauthenticated routes
if ($action === 'login') {
    $data = json_decode(file_get_contents('php://input'), true);
    $username = $data['username'] ?? '';
    $password = $data['password'] ?? '';

    $stmt = $db->prepare("SELECT * FROM users WHERE username = ?");
    $stmt->execute([$username]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($user && password_verify($password, $user['password_hash'])) {
        $_SESSION['user_id'] = $user['id'];
        $_SESSION['username'] = $user['username'];
        $_SESSION['role'] = $user['role'];
        respond('success', ['username' => $user['username'], 'role' => $user['role']], 'Logged in successfully');
    } else {
        respond('error', [], 'Invalid credentials');
    }
}

if ($action === 'check_auth') {
    if (isset($_SESSION['user_id'])) {
        respond('success', ['username' => $_SESSION['username'], 'role' => $_SESSION['role']]);
    } else {
        respond('error', [], 'Not authenticated');
    }
}

// Ensure Authentication for all subsequent routes
if (!isset($_SESSION['user_id'])) {
    respond('error', [], 'Unauthorized');
}

// Authenticated Routes
switch ($action) {
    case 'logout':
        session_destroy();
        respond('success', [], 'Logged out');
        break;

    // --- Account Management ---
    case 'list_users':
        if ($_SESSION['role'] !== 'admin') respond('error', [], 'Unauthorized');
        $stmt = $db->query("SELECT id, username, role FROM users");
        respond('success', $stmt->fetchAll(PDO::FETCH_ASSOC));
        break;

    case 'create_user':
        if ($_SESSION['role'] !== 'admin') respond('error', [], 'Unauthorized');
        $data = json_decode(file_get_contents('php://input'), true);
        $hash = password_hash($data['password'], PASSWORD_DEFAULT);
        $role = $data['role'] ?? 'user';
        
        try {
            $stmt = $db->prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)");
            $stmt->execute([$data['username'], $hash, $role]);
            respond('success', [], 'User created');
        } catch (PDOException $e) {
            respond('error', [], 'Username might already exist');
        }
        break;

    case 'delete_user':
        if ($_SESSION['role'] !== 'admin') respond('error', [], 'Unauthorized');
        $data = json_decode(file_get_contents('php://input'), true);
        
        // Prevent deleting yourself
        if ($data['id'] == $_SESSION['user_id']) respond('error', [], 'Cannot delete your own account');

        $stmt = $db->prepare("DELETE FROM users WHERE id = ?");
        $stmt->execute([$data['id']]);
        respond('success', [], 'User deleted');
        break;

    // --- File Manager ---
    case 'list_dir':
        $path = $_GET['path'] ?? '';
        $fullPath = getFullPath($path);
        
        if (!is_dir($fullPath)) {
            respond('error', [], 'Directory not found: ' . $fullPath);
        }

        $items = [];
        $scanned = scandir($fullPath);
        foreach ($scanned as $item) {
            if ($item === '.' || $item === '..') continue;
            $itemPath = $fullPath . DIRECTORY_SEPARATOR . $item;
            $ext = strtolower(pathinfo($item, PATHINFO_EXTENSION));
            
            if (in_array($ext, ['jpg', 'jpeg', 'png', 'gif', 'webp'])) {
                $type = 'image';
            } elseif (in_array($ext, ['mp4', 'webm', 'ogg', 'mov'])) {
                $type = 'video';
            } elseif (in_array($ext, ['mp3', 'wav'])) {
                $type = 'audio';
            } else {
                // Only perform the expensive network stat if we don't recognize the extension
                if (is_dir($itemPath)) {
                    $type = 'folder';
                } else {
                    $type = 'file';
                }
            }

            $items[] = [
                'name' => $item,
                'path' => ($path === '' ? '' : $path . '/') . $item,
                'type' => $type,
                'size' => 0,
                'modified' => 0
            ];
        }
        
        // Sort: folders first, then alphabetically
        usort($items, function($a, $b) {
            if ($a['type'] === 'folder' && $b['type'] !== 'folder') return -1;
            if ($a['type'] !== 'folder' && $b['type'] === 'folder') return 1;
            return strcasecmp($a['name'], $b['name']);
        });

        respond('success', $items);
        break;

    case 'get_metadata':
        session_write_close();
        $data = json_decode(file_get_contents('php://input'), true);
        $path = $data['path'] ?? '';
        $fullPath = getFullPath($path);
        $files = $data['files'] ?? [];
        
        $meta = [];
        foreach ($files as $file) {
            $itemPath = $fullPath . DIRECTORY_SEPARATOR . $file;
            if (file_exists($itemPath)) {
                $meta[] = [
                    'name' => $file,
                    'size' => (int)@filesize($itemPath),
                    'modified' => (int)@filemtime($itemPath)
                ];
            }
        }
        respond('success', $meta);
        break;

    case 'delete_file':
        $data = json_decode(file_get_contents('php://input'), true);
        $fullPath = getFullPath($data['path']);
        
        if (is_file($fullPath)) {
            if (unlink($fullPath)) respond('success', [], 'File deleted');
            else respond('error', [], 'Failed to delete file');
        } elseif (is_dir($fullPath)) {
            // Very simple recursive delete could be implemented here, but for safety, we only delete empty dirs for now
            if (@rmdir($fullPath)) respond('success', [], 'Directory deleted');
            else respond('error', [], 'Failed to delete directory (must be empty)');
        } else {
            respond('error', [], 'Path not found');
        }
        break;

    case 'copy_file':
        $data = json_decode(file_get_contents('php://input'), true);
        $sourcePath = getFullPath($data['source']);
        $destPath = getFullPath($data['dest']);
        
        if (!is_file($sourcePath)) respond('error', [], 'Source file not found');
        if (file_exists($destPath)) respond('error', [], 'Destination already exists');

        if (copy($sourcePath, $destPath)) {
            respond('success', [], 'File copied successfully');
        } else {
            respond('error', [], 'Failed to copy file');
        }
        break;

    case 'stream':
        // Close session write lock to allow concurrent requests (crucial for video buffering & seeking!)
        session_write_close();
        
        // Disable execution time limit so large videos don't get killed by PHP after 30 seconds
        @set_time_limit(0);
        
        // Disable Apache gzip compression which destroys HTTP_RANGE byte offsets
        if (function_exists('apache_setenv')) {
            @apache_setenv('no-gzip', '1');
        }
        @ini_set('zlib.output_compression', 'Off');
        
        // For viewing images, playing videos/audio directly
        $path = $_GET['path'] ?? '';
        $fullPath = getFullPath($path);
        
        if (!is_file($fullPath)) {
            http_response_code(404);
            die("File not found");
        }

        $ext = strtolower(pathinfo($fullPath, PATHINFO_EXTENSION));
        $mime_types = [
            'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png', 'gif' => 'image/gif', 'webp' => 'image/webp',
            'mp4' => 'video/mp4', 'webm' => 'video/webm', 'ogg' => 'video/ogg',
            'mp3' => 'audio/mpeg', 'wav' => 'audio/wav',
            'txt' => 'text/plain', 'pdf' => 'application/pdf'
        ];
        
        $mime = $mime_types[$ext] ?? 'application/octet-stream';
        $size = filesize($fullPath);
        $time = date('r', filemtime($fullPath));
        
        header('Content-Type: ' . $mime);
        header('Content-Length: ' . $size);
        header('Last-Modified: ' . $time);
        header('Cache-Control: public, max-age=31536000, immutable');
        
        if (isset($_SERVER['HTTP_IF_MODIFIED_SINCE']) && strtotime($_SERVER['HTTP_IF_MODIFIED_SINCE']) >= filemtime($fullPath)) {
            http_response_code(304);
            exit;
        }
        
        $fm = @fopen($fullPath, 'rb');
        if (!$fm) {
            http_response_code(500);
            die("Could not open file");
        }

        $begin = 0;
        $end = $size - 1;

        if (isset($_SERVER['HTTP_RANGE'])) {
            if (preg_match('/bytes=\h*(\d+)-(\d*)[\D.*]?/i', $_SERVER['HTTP_RANGE'], $matches)) {
                $begin = intval($matches[1]);
                if (!empty($matches[2])) {
                    $end = intval($matches[2]);
                }
            }
            
            // HTTP spec: if end exceeds file size, truncate it, do not return 416
            $end = min($end, $size - 1);
            
            if ($begin >= $size || $begin > $end) {
                header('HTTP/1.1 416 Requested Range Not Satisfiable');
                header("Content-Range: bytes */$size");
                exit;
            }
            
            header('HTTP/1.1 206 Partial Content');
            header("Content-Type: $mime");
            header('Accept-Ranges: bytes');
            header('Content-Length: ' . (($end - $begin) + 1));
            header("Content-Range: bytes $begin-$end/$size");
            $disp = isset($_GET['dl']) ? 'attachment' : 'inline';
            header("Content-Disposition: $disp; filename=".basename($fullPath));
            header("Content-Transfer-Encoding: binary");
            header("Last-Modified: $time");

            // Disable PHP output buffering completely to prevent XAMPP from starving the stream
            while (ob_get_level()) ob_end_clean();

            // Use C-optimized stream_copy_to_stream for maximum throughput instead of PHP memory loops
            fseek($fm, $begin, 0);
            $out = fopen('php://output', 'wb');
            stream_copy_to_stream($fm, $out, ($end - $begin) + 1);
            fclose($out);
        } else {
            // Optimized full-file stream in 512KB chunks
            header('HTTP/1.1 200 OK');
            header("Content-Type: $mime");
            header('Content-Length: ' . $size);
            header('Accept-Ranges: bytes');
            
            $disp = isset($_GET['dl']) ? 'attachment' : 'inline';
            header("Content-Disposition: $disp; filename=".basename($fullPath));
            header("Last-Modified: $time");
            // Disable PHP output buffering completely
            while (ob_get_level()) ob_end_clean();
            
            // readfile() is highly optimized in C and avoids PHP memory allocation overhead for large files
            readfile($fullPath);
        }
        
        fclose($fm);
        exit;

    case 'thumbnail':
        session_write_close();
        // Generate a simple thumbnail for images
        $path = $_GET['path'] ?? '';
        $fullPath = getFullPath($path);
        $mtime = $_GET['mtime'] ?? 0;
        
        $thumbDir = __DIR__ . '/.thumbs';
        if (!is_dir($thumbDir)) @mkdir($thumbDir);
        
        // Use provided mtime to avoid slow SMB filemtime()
        if (!$mtime && file_exists($fullPath)) $mtime = filemtime($fullPath);
        $thumbName = md5($fullPath) . '_' . $mtime . '.jpg';
        $thumbPath = $thumbDir . '/' . $thumbName;

        header('Cache-Control: public, max-age=31536000, immutable');

        // Serve instantly from local disk if cached, bypassing SMB completely
        if (file_exists($thumbPath)) {
            header('Content-Type: image/jpeg');
            header('Content-Length: ' . filesize($thumbPath));
            readfile($thumbPath);
            exit;
        }

        if (!is_file($fullPath)) {
            http_response_code(404);
            die("File not found");
        }

        $ext = strtolower(pathinfo($fullPath, PATHINFO_EXTENSION));
        if (!in_array($ext, ['jpg', 'jpeg', 'png', 'gif', 'webp'])) {
            header('Location: ?action=stream&path=' . urlencode($path));
            exit;
        }

        // Check if GD extension is loaded, if not just stream the original
        if (!function_exists('imagecreatetruecolor') || !is_dir($thumbDir)) {
            header('Location: ?action=stream&path=' . urlencode($path));
            exit;
        }

        if (!file_exists($thumbPath)) {
            // Create thumbnail
            $size = @getimagesize($fullPath);
            if (!$size || $size[0] == 0) {
                header('Location: ?action=stream&path=' . urlencode($path));
                exit;
            }
            
            $width = $size[0];
            $height = $size[1];
            $new_width = 300;
            $new_height = floor($height * ($new_width / $width));

            $thumb = imagecreatetruecolor($new_width, $new_height);
            $source = false;
            
            // Suppress warnings for corrupted/huge images
            if ($ext == 'jpg' || $ext == 'jpeg') $source = @imagecreatefromjpeg($fullPath);
            elseif ($ext == 'png') {
                $source = @imagecreatefrompng($fullPath);
                if ($source) {
                    imagealphablending($thumb, false);
                    imagesavealpha($thumb, true);
                }
            }
            elseif ($ext == 'gif') $source = @imagecreatefromgif($fullPath);
            elseif ($ext == 'webp' && function_exists('imagecreatefromwebp')) $source = @imagecreatefromwebp($fullPath);
            
            if (!$source) {
                // Out of memory or unsupported format, fallback to original
                imagedestroy($thumb);
                header('Location: ?action=stream&path=' . urlencode($path));
                exit;
            }
            
            imagecopyresampled($thumb, $source, 0, 0, 0, 0, $new_width, $new_height, $width, $height);
            imagejpeg($thumb, $thumbPath, 80);
            
            imagedestroy($thumb);
            imagedestroy($source);
        }

        header('Content-Type: image/jpeg');
        header('Content-Length: ' . filesize($thumbPath));
        readfile($thumbPath);
        exit;

    default:
        respond('error', [], 'Invalid action');
}
