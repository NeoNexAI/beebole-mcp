/**
 * Smoke test e2e contra la API GraphQL real de Beebole (app.beebole.com/graphql).
 *
 * Uso:
 *   BEEBOLE_API_KEY=<key> npm run smoke
 *   BEEBOLE_API_KEY=<key> SMOKE_WRITE=1 npm run smoke   ← incluye un ciclo de
 *       escritura (crear proyecto → fichar → editar → borrar → archivar) que
 *       SOLO debe usarse en una cuenta de PRUEBAS (deja todo limpio al terminar).
 *
 * Salida: lista de checks con OK/FALLO y un resumen. Código de salida ≠ 0 si algo
 * falla, para poder usarlo en CI / como gate de "operativo-verificado".
 */

import { BeeboleClient } from './client.js';

const key = (process.env.BEEBOLE_API_KEY ?? '').trim();
if (!key) {
  process.stderr.write('Falta BEEBOLE_API_KEY en el entorno.\n');
  process.exit(2);
}

const beebole = new BeeboleClient(key);
let ok = 0;
let fail = 0;

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    ok++;
    process.stdout.write(`  ✓ ${name}${detail ? ` — ${detail}` : ''}\n`);
  } catch (err) {
    fail++;
    process.stdout.write(`  ✗ ${name} — ${(err as Error).message}\n`);
  }
}

const now = Date.now();
const days30 = 30 * 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  process.stdout.write('\n== Beebole GraphQL smoke (lectura) ==\n');

  await check('currentPerson', async () => {
    const d = await beebole.graphql<{ currentPerson: { id: string; name: string; email: string } }>(
      '{ currentPerson{ id name email } }',
    );
    if (!d.currentPerson?.id) throw new Error('sin currentPerson');
    return `${d.currentPerson.name} <${d.currentPerson.email}>`;
  });

  await check('currentOrganisation', async () => {
    const d = await beebole.graphql<{ currentOrganisation: { id: string; name: string } }>(
      '{ currentOrganisation{ id name } }',
    );
    return d.currentOrganisation?.name ?? '(sin nombre)';
  });

  await check('getProjects', async () => {
    const d = await beebole.graphql<{ getProjects: unknown[] }>('{ getProjects{ id name } }');
    return `${d.getProjects?.length ?? 0} proyectos`;
  });

  await check('getTasks', async () => {
    const d = await beebole.graphql<{ getTasks: unknown[] }>('{ getTasks{ id name } }');
    return `${d.getTasks?.length ?? 0} tareas`;
  });

  await check('getPersons', async () => {
    const d = await beebole.graphql<{ getPersons: unknown[] }>('{ getPersons{ id name } }');
    return `${d.getPersons?.length ?? 0} personas`;
  });

  await check('getTags', async () => {
    const d = await beebole.graphql<{ getTags: unknown[] }>('{ getTags{ id name } }');
    return `${d.getTags?.length ?? 0} tags`;
  });

  await check('getAbsenceTypes', async () => {
    const d = await beebole.graphql<{ getAbsenceTypes: unknown[] }>('{ getAbsenceTypes{ id name unit } }');
    return `${d.getAbsenceTypes?.length ?? 0} tipos`;
  });

  await check('getReports', async () => {
    const d = await beebole.graphql<{ getReports: unknown[] }>('{ getReports{ id name } }');
    return `${d.getReports?.length ?? 0} informes`;
  });

  await check('countTimeRecords (30d)', async () => {
    const d = await beebole.graphql<{ countTimeRecords: number }>(
      'query($s:BeeboleTimestamp,$e:BeeboleTimestamp){ countTimeRecords(startTime:$s,endTime:$e) }',
      { s: now - days30, e: now },
    );
    return `${d.countTimeRecords} registros`;
  });

  if (process.env.SMOKE_WRITE === '1') {
    process.stdout.write('\n== Ciclo de ESCRITURA (cuenta de pruebas) ==\n');
    let projectId = '';
    let taskId = '';
    let personId = '';
    let projectCatId = '';
    let taskCatId = '';
    let trId = '';
    const startOfDay = now - (now % 86_400_000); // medianoche UTC de hoy

    await check('whoami → personId', async () => {
      const d = await beebole.graphql<{ currentPerson: { id: string } }>('{ currentPerson{ id } }');
      personId = d.currentPerson.id;
      return personId;
    });

    await check('getProjectCategories + getTaskCategories', async () => {
      const d = await beebole.graphql<{
        getProjectCategories: { id: string }[];
        getTaskCategories: { id: string }[];
      }>('{ getProjectCategories{ id name } getTaskCategories{ id name } }');
      projectCatId = d.getProjectCategories?.[0]?.id ?? '';
      taskCatId = d.getTaskCategories?.[0]?.id ?? '';
      if (!projectCatId || !taskCatId) throw new Error('faltan categorías por defecto');
      return `projCat=${projectCatId} taskCat=${taskCatId}`;
    });

    await check('addProject (con categoría)', async () => {
      const d = await beebole.graphql<{ addProject: { id: string } }>(
        'mutation($n:BeeboleName!,$c:BeeboleId){ addProject(name:$n,categoryId:$c){ id name } }',
        { n: 'ZZ_SMOKE_TEST_PROJECT', c: projectCatId },
      );
      projectId = d.addProject.id;
      return projectId;
    });

    await check('addTask (con categoría)', async () => {
      const d = await beebole.graphql<{ addTask: { id: string } }>(
        'mutation($n:BeeboleName!,$c:BeeboleId){ addTask(name:$n,categoryId:$c){ id name } }',
        { n: 'ZZ_SMOKE_TEST_TASK', c: taskCatId },
      );
      taskId = d.addTask.id;
      return taskId;
    });

    await check('assignTaskToProject', async () => {
      await beebole.graphql(
        'mutation($t:BeeboleId!,$p:BeeboleId!){ assignTaskToProject(taskId:$t,projectId:$p){ id } }',
        { t: taskId, p: projectId },
      );
      return 'asignada';
    });

    await check('addTimeRecord (90 min)', async () => {
      const d = await beebole.graphql<{ addTimeRecord: { id: string; duration: number } }>(
        'mutation($s:BeeboleTimestamp!,$dur:Int!,$p:BeeboleId!,$t:BeeboleId,$pr:[BeeboleId]){ addTimeRecord(startTime:$s,duration:$dur,personId:$p,taskId:$t,projectIds:$pr){ id duration } }',
        { s: startOfDay, dur: 90, p: personId, t: taskId, pr: projectId ? [projectId] : undefined },
      );
      trId = d.addTimeRecord.id;
      return `id=${trId} duration=${d.addTimeRecord.duration}`;
    });

    await check('editTimeRecordComment', async () => {
      const d = await beebole.graphql<{ editTimeRecordComment: { comment: string } }>(
        'mutation($id:BeeboleId!,$c:String!){ editTimeRecordComment(id:$id,comment:$c){ comment } }',
        { id: trId, c: 'smoke test' },
      );
      return `comment="${d.editTimeRecordComment.comment}"`;
    });

    await check('deleteTimeRecords', async () => {
      await beebole.graphql('mutation($ids:[BeeboleId!]!){ deleteTimeRecords(ids:$ids){ id } }', { ids: [trId] });
      return 'borrado';
    });

    await check('cleanup: deleteTask + deleteProject', async () => {
      if (taskId) await beebole.graphql('mutation($id:BeeboleId!){ deleteTask(id:$id){ id } }', { id: taskId });
      if (projectId)
        await beebole.graphql('mutation($id:BeeboleId!){ deleteProject(id:$id){ id } }', { id: projectId });
      return 'borrados';
    });
  }

  process.stdout.write(`\n== Resumen: OK=${ok}  FALLO=${fail} ==\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`Smoke abortado: ${(err as Error).message}\n`);
  process.exit(1);
});
