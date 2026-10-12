<?php
/**
 * Filenymous delivery receipts — status endpoint.
 * GET ?id=<receipt id> -> {ok, id, open, download} (timestamps in ms or null).
 */
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$id = isset($_GET['id']) ? (string) $_GET['id'] : '';
if (!preg_match('/^[A-Za-z0-9_-]{10,64}$/', $id)) {
    http_response_code(400);
    echo json_encode(['ok' => false]);
    exit;
}

$out = ['ok' => true, 'id' => $id, 'open' => null, 'download' => null];
$candidates = [dirname(__DIR__, 2) . '/filenymous-rcpt-data', __DIR__ . '/rcpt-data'];
foreach ($candidates as $dir) {
    $file = $dir . '/' . $id . '.json';
    if (is_file($file)) {
        $rec = json_decode((string) @file_get_contents($file), true);
        if (is_array($rec)) {
            $out['open'] = $rec['open'] ?? null;
            $out['download'] = $rec['download'] ?? null;
        }
        break;
    }
}
echo json_encode($out);
