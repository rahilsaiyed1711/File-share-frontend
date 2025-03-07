import { Request, Response } from 'express';

import { errorResponse, notFoundResponse, successResponse, successResponseWithPagination, validationError } from '../helpers/api-responses';
import { LeaveHistory, User } from '../models';
import utils from '../helpers/utils';
import mongoose from 'mongoose';
import constants from '../helpers/constants';

const addLeave = async (req, res) => {
    try {
      const { userIds, LeaveType, credit, debit, descraption } = req.body;
      const userId = await utils.getUserId(req);
      const loginUser = await User.findById(userId).populate<{ companyId: { companyName: string } }>('companyId');
  
      if (!loginUser) {
        return notFoundResponse(res, 'Admin user not found');
      }
  
      if (loginUser.role === constants.ROLE.EMPLOYEE) {
        return validationError(res, 'You are not authorized to add leave for other users');
      }
  
      if (!Array.isArray(userIds) || userIds.length === 0) {
        return validationError(res, 'Users array is required and cannot be empty');
      }
  
      if (!LeaveType) {
        return validationError(res, 'Leave Type is required');
      }
  
      if (credit !== undefined && (typeof credit !== 'number' || credit <= 0)) {
        return validationError(res, 'Credit must be a positive number');
      }
      
      if (debit !== undefined && (typeof debit !== 'number' || debit <= 0)) {
        return validationError(res, 'Debit must be a positive number');
      }
  
      if (!descraption) {
        return validationError(res, 'Description is required');
      }
  
      const leaveRecords = await Promise.all(
        userIds.map(async (userData) => {
          const user = await User.findById(userData);
          if (!user) {
            throw new Error(`User not found`);
          }
          const latestLeave = await LeaveHistory.findOne({ userId: userData, isDeleted: { $ne: true } }).sort({ createdAt: -1 }).exec();
          const availablePL = latestLeave?.availablePL || 0;
          const availableCompOff = latestLeave?.availableCompOff || 0;
          const finalCredit = credit || 0;
          const finalDebit = debit || 0;
          
          let updatedAvailablePL = availablePL;
          let updatedAvailableCompOff = availableCompOff;
      
          if (LeaveType === 'CL') {
            if(finalDebit > availableCompOff){
              throw new Error(
                `Insufficient available compoff balance for user ID: ${user.firstName} ${user.lastName}. Current balance: ${availableCompOff}, requested debit: ${finalDebit}`
              );
            }
            updatedAvailableCompOff = availableCompOff + finalCredit - finalDebit;
          } else {
            if (finalDebit > availablePL) {
              throw new Error(
                `Insufficient available leave balance for user ID: ${user.firstName} ${user.lastName}. Current balance: ${availablePL}, requested debit: ${finalDebit}`
              );
            }
            updatedAvailablePL = availablePL + finalCredit - finalDebit;
          }
          const newLeave = new LeaveHistory({
            companyId: loginUser.companyId,
            userId: new mongoose.Types.ObjectId(userData),
            leaveType: LeaveType,
            credited: finalCredit,
            debited: finalDebit,
            availablePL: updatedAvailablePL,
            availableCompOff: updatedAvailableCompOff,
            description: descraption,
          });
      
          await newLeave.save();
          return newLeave;
        })
      );      
  
      return successResponse(res, 'Leave records created successfully', leaveRecords);
    } catch (error) {
      return errorResponse(res, error.message);
    }
  };
  

const getManualLeaves = async (req, res) => {
  try {
    const userId = await utils.getUserId(req);
    const user = await User.findById(userId);
    if (!user) {
      return notFoundResponse(res, 'User not found');
    }
    if (user?.role === constants.ROLE.EMPLOYEE) {
      return validationError(res, 'You are not authorized to delete project');
    }
    const limit = parseInt(req.query.limit , 10) || 10;
    const offset = parseInt(req.query.offset , 10) || 1;

    const result = await LeaveHistory.aggregate([
      {
        $match: {
          isDeleted: false,
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'userDetails',
        },
      },
      {
        $unwind: '$userDetails',
      },
      {
        $sort: {
          updatedAt: -1,
        },
      },
      {
        $project: {
          _id: 1,
          userId: '$userId',
          name: { $concat: ['$userDetails.firstName', ' ', '$userDetails.lastName'] },
          credited: '$credited',
          debited: '$debited',
          previousLeaves: { $subtract: ['$availablePL', '$credited'] },
          totalLeaves: { $add: [{ $subtract: ['$availablePL', '$credited'] }, '$credited'] },
          updatedAt: '$updatedAt',
        },
      },
      {
        $facet: {
          data: [{ $skip: (offset - 1) * limit }, { $limit: limit }],
          totalCount: [
            { $count: 'totalCount' },
            {
              $addFields: {
                totalCount: { $ifNull: ['$totalCount', 0] },
              },
            },
          ],
        },
      },
    ]);

    const data = result[0]?.data || [];
    const totalRecords = result?.[0]?.totalCount?.[0]?.totalCount || 0;
    return successResponseWithPagination(res, 'Manage Leave fetched successfully', totalRecords, data, limit);
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const deleteManualLeaves = async (req, res) => {
  try {
    const userId = await utils.getUserId(req);
    const user = await User.findById(userId);
    if (!user) {
      return validationError(res, 'User not found');
    }

    if (user.role === constants.ROLE.EMPLOYEE) {
      return validationError(res, 'You are not authorized to delete project');
    }

    const { id } = req.body;

    const manualLeave = [
      { _id: id },
      {
        $set: {
          isDeleted: true,
          deletedAt: new Date(),
        },
      },
      { new: true },
    ];
    const deletedLeave = await LeaveHistory.findOneAndUpdate(...manualLeave);
    if (!deletedLeave) {
      return errorResponse(res, 'Leave not found');
    }

    return successResponse(res, 'Leave deleted successfully', null);
  } catch (error) {
    return errorResponse(res, `Failed to delete Leave: ${error.message}`);
  }
};

export default {
  addLeave,
  getManualLeaves,
  deleteManualLeaves
}