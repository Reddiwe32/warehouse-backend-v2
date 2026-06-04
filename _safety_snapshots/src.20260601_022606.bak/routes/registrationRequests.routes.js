const express = require('express');
const controller = require('../controllers/registrationRequests.controller');

const router = express.Router();

router.post('/', controller.createRegistrationRequest);
router.get('/', controller.listRegistrationRequests);
router.post('/:id/approve', controller.approveRegistrationRequest);
router.post('/:id/reject', controller.rejectRegistrationRequest);

module.exports = router;
