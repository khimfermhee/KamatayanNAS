<?php
session_start();
header('Content-Type: application/json');

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
            
            header('HTTP/1.1 206 Partial Content');
            header("Content-Type: $mime");
            header('Cache-Control: public, must-revalidate, max-age=0');
            header('Pragma: no-cache');  
            header('Accept-Ranges: bytes');
            header('Content-Length:' . (($end - $begin) + 1));
            header("Content-Range: bytes $begin-$end/$size");
            header("Content-Disposition: inline; filename=".basename($fullPath));
            header("Content-Transfer-Encoding: binary");
            header("Last-Modified: $time");

            $cur = $begin;
            fseek($fm, $begin, 0);

            // Stream file in chunks (16KB) for video seeking
            while(!feof($fm) && $cur <= $end && (connection_status() == 0)) {
                print fread($fm, min(1024 * 16, ($end - $cur) + 1));
                $cur += 1024 * 16;
                flush();
            }
        } else {
            // Optimized full-file stream for images/initial video requests
            header('HTTP/1.1 200 OK');
            header("Content-Type: $mime");
            header('Content-Length: ' . $size);
            header('Accept-Ranges: bytes');
            header("Content-Disposition: inline; filename=".basename($fullPath));
            header("Last-Modified: $time");
            readfile($fullPath);
        }
        
        fclose($fm);
        exit;

    case 'preview':
        // Generate a 1280px preview for fast lightbox viewing
        $path = $_GET['path'] ?? '';
        $fullPath = getFullPath($path);
        if (!is_file($fullPath)) { http_response_code(404); die(); }
        $ext = strtolower(pathinfo($fullPath, PATHINFO_EXTENSION));
        if (!in_array($ext, ['jpg', 'jpeg', 'png', 'gif', 'webp'])) {
            header('Location: ?action=stream&path=' . urlencode($path));
            exit;
        }

        $previewDir = __DIR__ . '/.previews';
        if (!is_dir($previewDir)) @mkdir($previewDir);
        $previewName = md5($fullPath) . '_' . filemtime($fullPath) . '.jpg';
        $previewPath = $previewDir . '/' . $previewName;

        if (!function_exists('imagecreatetruecolor') || !is_dir($previewDir)) {
            header('Location: ?action=stream&path=' . urlencode($path));
            exit;
        }

        if (!file_exists($previewPath)) {
            $size = @getimagesize($fullPath);
            if (!$size || $size[0] == 0) { header('Location: ?action=stream&path=' . urlencode($path)); exit; }
            $width = $size[0]; $height = $size[1];
            
            // Only resize if it's larger than 1280px
            if ($width > 1280 || $height > 1280) {
                if ($width > $height) { $new_width = 1280; $new_height = floor($height * (1280 / $width)); }
                else { $new_height = 1280; $new_width = floor($width * (1280 / $height)); }
            } else {
                header('Location: ?action=stream&path=' . urlencode($path)); exit;
            }

            $thumb = imagecreatetruecolor($new_width, $new_height);
            $source = false;
            if ($ext == 'jpg' || $ext == 'jpeg') $source = @imagecreatefromjpeg($fullPath);
            elseif ($ext == 'png') { $source = @imagecreatefrompng($fullPath); if($source) { imagealphablending($thumb, false); imagesavealpha($thumb, true); } }
            elseif ($ext == 'gif') $source = @imagecreatefromgif($fullPath);
            elseif ($ext == 'webp' && function_exists('imagecreatefromwebp')) $source = @imagecreatefromwebp($fullPath);
            
            if (!$source) { imagedestroy($thumb); header('Location: ?action=stream&path=' . urlencode($path)); exit; }
            imagecopyresampled($thumb, $source, 0, 0, 0, 0, $new_width, $new_height, $width, $height);
            imagejpeg($thumb, $previewPath, 85);
            imagedestroy($thumb); imagedestroy($source);
        }
        header('Content-Type: image/jpeg');
        header('Content-Length: ' . filesize($previewPath));
        readfile($previewPath);
        exit;

    case 'thumbnail':
        // Generate a simple thumbnail for images
        $path = $_GET['path'] ?? '';
        $fullPath = getFullPath($path);
        
        if (!is_file($fullPath)) {
            http_response_code(404);
            die("File not found");
        }

        $ext = strtolower(pathinfo($fullPath, PATHINFO_EXTENSION));
        if (!in_array($ext, ['jpg', 'jpeg', 'png', 'gif', 'webp'])) {
            header('Location: ?action=stream&path=' . urlencode($path));
            exit;
        }

        // Cache thumbnails in a local dir for speed
        $thumbDir = __DIR__ . '/.thumbs';
        if (!is_dir($thumbDir)) {
            @mkdir($thumbDir);
        }
        
        $thumbName = md5($fullPath) . '_' . filemtime($fullPath) . '.jpg';
        $thumbPath = $thumbDir . '/' . $thumbName;

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
