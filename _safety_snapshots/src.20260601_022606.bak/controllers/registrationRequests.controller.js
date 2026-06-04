const service = require('../services/registrationRequests.service');

async function createRegistrationRequest(req, res, next) {
  try {
    const result = await service.create(req.body);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

async function listRegistrationRequests(req, res, next) {
  try {
    const result = await service.list(req.query);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

async function approveRegistrationRequest(req, res, next) {
  try {
    const result = await service.approve(Number(req.params.id), req.body, req.user || null);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

async function rejectRegistrationRequest(req, res, next) {
  try {
    const result = await service.reject(Number(req.params.id), req.body, req.user || null);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createRegistrationRequest,
  listRegistrationRequests,
  approveRegistrationRequest,
  rejectRegistrationRequest,
};
