import {
  addProjectNote,
  createProjectFollowup,
  getProjectBoardDetail,
  getProjectCalendar,
  listProjectBoard,
  listProjectBoardUsers,
  updateProjectBoard,
  updateProjectFollowup,
} from "../services/projectBoard.service.js";

const fail=(res,error)=>{
  const status=Number(error?.status)||500;
  if(status>=500) console.error("Project Board error:",error);
  return res.status(status).json({
    success:false,
    message:error?.message||"No fue posible procesar el Board",
    code:error?.code||"PROJECT_BOARD_ERROR",
  });
};

export const listProjectBoardController=async(req,res)=>{
  try{return res.status(200).json({success:true,...await listProjectBoard({query:req.query})});}
  catch(error){return fail(res,error);}
};
export const getProjectBoardDetailController=async(req,res)=>{
  try{return res.status(200).json({success:true,data:await getProjectBoardDetail({quotationId:req.params.quotationId})});}
  catch(error){return fail(res,error);}
};
export const updateProjectBoardController=async(req,res)=>{
  try{return res.status(200).json({success:true,data:await updateProjectBoard({
    quotationId:req.params.quotationId,actorUserId:req.user.id,body:req.body,
  })});}
  catch(error){return fail(res,error);}
};
export const addProjectNoteController=async(req,res)=>{
  try{return res.status(201).json({success:true,data:await addProjectNote({
    quotationId:req.params.quotationId,actorUserId:req.user.id,note:req.body?.note,
  })});}
  catch(error){return fail(res,error);}
};
export const createProjectFollowupController=async(req,res)=>{
  try{return res.status(201).json({success:true,data:await createProjectFollowup({
    quotationId:req.params.quotationId,actorUserId:req.user.id,body:req.body,
  })});}
  catch(error){return fail(res,error);}
};
export const updateProjectFollowupController=async(req,res)=>{
  try{return res.status(200).json({success:true,data:await updateProjectFollowup({
    quotationId:req.params.quotationId,followupId:req.params.followupId,actorUserId:req.user.id,body:req.body,
  })});}
  catch(error){return fail(res,error);}
};
export const getProjectCalendarController=async(req,res)=>{
  try{return res.status(200).json({success:true,...await getProjectCalendar({query:req.query})});}
  catch(error){return fail(res,error);}
};
export const listProjectBoardUsersController=async(req,res)=>{
  try{return res.status(200).json({success:true,...await listProjectBoardUsers()});}
  catch(error){return fail(res,error);}
};
