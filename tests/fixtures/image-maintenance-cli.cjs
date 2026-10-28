const { readFileSync, appendFileSync, existsSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const log = event => appendFileSync(process.env.IMAGE_JOB_TEST_LOG, `${JSON.stringify(event)}\n`);
if (args[0] === 'db') {
  const request = JSON.parse(args[args.indexOf('--command') + 1])[0];
  const command = JSON.parse(request.Command);
  log({ type: request.CommandType, command });
  const rows = request.CommandType === 'QUERY'
    ? Array.from({ length: 8 }, (_, index) => ({ _id: `media-${index}`, fileId: `cloud://test/photo-${index}` }))
    : [{ ok: { $numberDouble: '1.0' }, n: { $numberInt: '1' }, operationTime: { $numberLong: '18446744073709551615' } }];
  console.log(JSON.stringify({ data: { results: [rows] } }));
} else if (args[0] === 'fn') {
  const request = JSON.parse(readFileSync(args[args.indexOf('-d') + 1].slice(1), 'utf8'));
  log({ type: 'INVOKE', fileIds: request.fileIds });
  const failures = [];
  const completed = request.fileIds.filter(fileId => {
    if (process.env.IMAGE_JOB_TEST_FAILURE && fileId.endsWith('photo-0') && !existsSync(process.env.IMAGE_JOB_TEST_FAILURE)) {
      writeFileSync(process.env.IMAGE_JOB_TEST_FAILURE, 'failed once');
      failures.push({ fileId, code: 'TEMPORARY' });
      return false;
    }
    return true;
  });
  setTimeout(() => console.log(JSON.stringify({ data: { Result: { RetMsg: JSON.stringify({ ok: true, data: { completed, failures } }) } } })), 20);
} else {
  throw new Error('Unexpected test CLI command');
}
