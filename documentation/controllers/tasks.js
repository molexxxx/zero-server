const Task = require('../models/Task');

const VALID_STATUSES = ['pending', 'in-progress', 'done'];

function clampPriority(v) { return Math.max(0, Math.min(5, Number(v) || 0)); }

exports.list = async (req, res) =>
{
    try
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
    }
    catch (e) { res.status(500).json({ error: e.message }); }
};

exports.create = async (req, res) =>
{
    try
    {
        const { title, status, priority } = req.body || {};
        if (!title || typeof title !== 'string' || !title.trim())
            return res.status(400).json({ error: 'title is required' });

        const task = await Task.create({
            title: title.trim().slice(0, 200),
            status: VALID_STATUSES.includes(status) ? status : 'pending',
            priority: clampPriority(priority),
        });
        res.status(201).json({ task });
    }
    catch (e) { res.status(500).json({ error: e.message }); }
};

exports.update = async (req, res) =>
{
    try
    {
        const task = await Task.findById(Number(req.params.id));
        if (!task) return res.status(404).json({ error: 'not found' });

        const updates = {};
        if (req.body.title != null) updates.title = String(req.body.title).trim().slice(0, 200);
        if (req.body.status != null && VALID_STATUSES.includes(req.body.status)) updates.status = req.body.status;
        if (req.body.priority != null) updates.priority = clampPriority(req.body.priority);
        await task.update(updates);
        res.json({ task });
    }
    catch (e) { res.status(500).json({ error: e.message }); }
};

exports.remove = async (req, res) =>
{
    try
    {
        const task = await Task.findById(Number(req.params.id));
        if (!task) return res.status(404).json({ error: 'not found' });
        await task.delete();
        res.json({ deleted: true, id: Number(req.params.id) });
    }
    catch (e) { res.status(500).json({ error: e.message }); }
};

exports.restore = async (req, res) =>
{
    try
    {
        const rows = await Task.query().withDeleted().where('id', '=', Number(req.params.id)).exec();
        const task = rows[0];
        if (!task) return res.status(404).json({ error: 'not found' });
        if (task.restore) await task.restore();
        res.json({ task });
    }
    catch (e) { res.status(500).json({ error: e.message }); }
};

exports.removeAll = async (req, res) =>
{
    try
    {
        const all = await Task.find();
        for (const t of all) await t.delete();
        res.json({ deleted: all.length });
    }
    catch (e) { res.status(500).json({ error: e.message }); }
};

exports.stats = async (req, res) =>
{
    try
    {
        const total = await Task.count();
        const pending = await Task.count({ status: 'pending' });
        const inProgress = await Task.count({ status: 'in-progress' });
        const done = await Task.count({ status: 'done' });
        const avgPriority = await Task.query().avg('priority');
        const maxPriority = await Task.query().max('priority');
        res.json({ total, pending, inProgress, done, avgPriority: avgPriority || 0, maxPriority: maxPriority || 0 });
    }
    catch (e) { res.status(500).json({ error: e.message }); }
};
