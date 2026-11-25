// Register a new revision of a gateway task definition with a different image tag.
// Usage: node taskdef.mjs <family> <imageTag>   -> prints the new task definition ARN
import { execFileSync } from 'node:child_process';

const [family, tag] = process.argv.slice(2);
if (!family || !tag) throw new Error('usage: taskdef.mjs <family> <imageTag>');

const aws = (...args) => JSON.parse(execFileSync('aws', [...args, '--output', 'json'], { encoding: 'utf8', maxBuffer: 1 << 24 }));
const { taskDefinition: td } = aws('ecs', 'describe-task-definition', '--task-definition', family);

for (const c of td.containerDefinitions) {
  if (c.name === 'gateway') c.image = `${c.image.replace(/:[^:/]+$/, '')}:${tag}`;
}
const keep = ['family', 'taskRoleArn', 'executionRoleArn', 'networkMode', 'containerDefinitions', 'volumes', 'requiresCompatibilities', 'cpu', 'memory', 'runtimePlatform'];
const input = Object.fromEntries(keep.filter((k) => td[k] !== undefined).map((k) => [k, td[k]]));

const out = execFileSync('aws', ['ecs', 'register-task-definition', '--cli-input-json', JSON.stringify(input), '--query', 'taskDefinition.taskDefinitionArn', '--output', 'text'], { encoding: 'utf8' });
process.stdout.write(out.trim());
