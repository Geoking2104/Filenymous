<?php
/**
 * Filenymous delivery receipts — report endpoint.
 * POST JSON {id, event:"open"|"download"} — stores {id, open, download} per id.
 */
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function rcpt_data_dir(): string {
    $outside = dirname(__DIR__, 2) . '/filenymous-rcpt-data';
    foreach ([$outside, __DIR__ . '/rcpt-data'] as $dir) {
        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        if (is_dir($dir) && is_writable($dir)) {
            if (strpos($dir, 'www') !== false) {
                @file_put_contents($dir . '/.htaccess', "Require all denied\nDeny from all\n");
            }
            return $dir;
        }
    }
    return __DIR__ . '/rcpt-data';
}

$raw = file_get_contents('php://input');
$d = json_decode((string) $raw, true);
$id = is_array($d) ? (string) ($d['id'] ?? '') : '';
$event = is_array($d) ? (string) ($d['event'] ?? '') : '';

if (!preg_match('/^[A-Za-z0-9_-]{10,64}$/', $id) || !in_array($event, ['open', 'download'], true)) {
    http_response_code(400);
    echo json_encode(['ok' => false]);
    exit;
}

$dir = rcpt_data_dir();
$file = $dir . '/' . $id . '.json';
$rec = ['id' => $id, 'open' => null, 'download' => null];
if (is_file($file)) {
    $prev = json_decode((string) @file_get_contents($file), true);
    if (is_array($prev)) {
        $rec = array_merge($rec, $prev);
    }
}

$now = (int) round(microtime(true) * 1000);
if ($event === 'open' && $rec['open'] === null) {
    $rec['open'] = $now;
}
if ($event === 'download') {
    $rec['download'] = $now;
}

@file_put_contents($file, json_encode($rec), LOCK_EX);
echo json_encode(['ok' => true]);
