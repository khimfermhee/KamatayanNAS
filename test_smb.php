<?php
$path = '\\\\192.168.100.66\\c'; // A test path
$start = microtime(true);

$iterator = new DirectoryIterator($path);
$count = 0;
foreach ($iterator as $fileinfo) {
    if (!$fileinfo->isDot()) {
        $name = $fileinfo->getFilename();
        $size = $fileinfo->getSize();
        $mtime = $fileinfo->getMTime();
        $count++;
    }
}

$end = microtime(true);
echo "DirectoryIterator took " . ($end - $start) . " seconds for $count files.\n";
