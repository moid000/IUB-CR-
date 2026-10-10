const g = await import('../backend/services/wasenderGateway.js');
const groups = await g.listGroups();
console.log('groups:', groups.length);
for (const x of groups) console.log('-', x.name.slice(0,24), '| parts:', x.participants.length, '| has 8787753:', x.participants.includes('923088787753'));
process.exit(0);
