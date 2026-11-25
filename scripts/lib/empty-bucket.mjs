// Delete every object version and delete marker in a (versioned) S3 bucket. Usage: node empty-bucket.mjs <bucket>
import { execFileSync } from 'node:child_process';

const bucket = process.argv[2];
if (!bucket) throw new Error('usage: empty-bucket.mjs <bucket>');
const aws = (...args) => execFileSync('aws', args, { encoding: 'utf8', maxBuffer: 1 << 26 });

for (;;) {
  const listing = JSON.parse(aws('s3api', 'list-object-versions', '--bucket', bucket, '--max-items', '500', '--output', 'json') || '{}');
  const objects = [...(listing.Versions ?? []), ...(listing.DeleteMarkers ?? [])].map((o) => ({ Key: o.Key, VersionId: o.VersionId }));
  if (!objects.length) break;
  aws('s3api', 'delete-objects', '--bucket', bucket, '--delete', JSON.stringify({ Objects: objects, Quiet: true }));
  console.log(`deleted ${objects.length} versions from ${bucket}`);
}
