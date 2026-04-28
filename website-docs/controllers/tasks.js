const { NotFoundError } = require('../..');
const Task = require('../models/Task');

function clampPriority(v) { return Math.max(0, Math.min(5, Number(v) || 0)); }

exports.list = async (req, res) =>
{
    let q = Task.query();
    if (req.query.status) q = q.where('status', '=', req.query.status);
    if (req.query.priority) q = q.where('priority', '>=', Number(req.query.priority));
    if (req.query.scope) q = q.scope(req.query.scope);
    if (req.query.search) q = q.whereLike('title', `%${req.query.search}%`);
    q = q.orderBy(req.query.sort || 'createdAt', req.query.order || 'desc');
    const tasks = await q.exec();
    const count = await Task.count();
    res.json({ tasks, total: count });
};

exports.create = async (req, res) =>
{
    const task = await Task.create({
        title: (req.body.title || '').trim().slice(0, 200),
        status: req.body.status || 'pending',
        priority: clampPriority(req.body.priority),
    });
    res.status(201).json({ task });
};

exports.update = async (req, res) =>
{
    const task = await Task.findById(Number(req.params.id));
    if (!task) throw new NotFoundError('Task not found');
    const updates = {};
    if (req.body.title != null) updates.title = String(req.body.title).trim().slice(0, 200);
    if (req.body.status != null) updates.status = req.body.status;
    if (req.body.priority != null) updates.priority = clampPriority(req.body.priority);
    await task.update(updates);
    res.json({ task });
};

exports.remove = async (req, res) =>
{
    const task = await Task.findById(Number(req.params.id));
    if (!task) throw new NotFoundError('Task not found');
    await task.delete();
    res.json({ deleted: true, id: Number(req.params.id) });
};

exports.restore = async (req, res) =>
{
    const rows = await Task.query().withDeleted().where('id', '=', Number(req.params.id)).exec();
    const task = rows[0];
    if (!task) throw new NotFoundError('Task not found');
    if (task.restore) await task.restore();
    res.json({ task });
};

exports.removeAll = async (req, res) =>
{
    const all = await Task.find();
    for (const t of all) await t.delete();
    res.json({ deleted: all.length });
};

exports.stats = async (req, res) =>
{
    const [total, pending, inProgress, done, avgPriority, maxPriority] = await Promise.all([
        Task.count(),
        Task.count({ status: 'pending' }),
        Task.count({ status: 'in-progress' }),
        Task.count({ status: 'done' }),
        Task.query().avg('priority'),
        Task.query().max('priority'),
    ]);
    res.json({ total, pending, inProgress, done, avgPriority: avgPriority || 0, maxPriority: maxPriority || 0 });
};
