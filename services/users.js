const firestore = require("../utils/firestore");
const { formatUsername } = require("../utils/username");
const userModel = firestore.collection("users");
const tasksModel = require("../models/tasks");
const dataAccess = require("./dataAccessLayer");
const { SOMETHING_WENT_WRONG, INTERNAL_SERVER_ERROR } = require("../constants/errorMessages");
const { isLastPRMergedWithinDays } = require("./githubService");
const { INDISCORD } = require("../constants/roles");
const { getUserStatus } = require("../models/userStatus");
const { generatePaginationLinks, getUsernamesFromPRs } = require("../utils/users");
const { getOverdueTasks } = require("../models/tasks");
const { getFilteredPRsOrIssues } = require("../utils/pullRequests");

const getUsersWithIncompleteTasks = async (users) => {
  if (users.length === 0) return [];

  try {
    const userIds = users.map((user) => user.id);

    const abandonedTasksQuerySnapshot = await tasksModel.fetchIncompleteTasksByUserIds(userIds);

    if (abandonedTasksQuerySnapshot.empty) {
      return [];
    }

    const userIdsWithIncompleteTasks = new Set(abandonedTasksQuerySnapshot.map((doc) => doc.assignee));

    const eligibleUsersWithTasks = users.filter((user) => userIdsWithIncompleteTasks.has(user.id));

    return eligibleUsersWithTasks;
  } catch (error) {
    logger.error(`Error in getting users who abandoned tasks: ${error}`);
    throw error;
  }
};

const generateUniqueUsername = async (firstName, lastName) => {
  try {
    const snapshot = await userModel
      .where("first_name", "==", firstName)
      .where("last_name", "==", lastName)
      .count()
      .get();

    const existingUserCount = snapshot.data().count || 0;

    const suffix = existingUserCount + 1;
    const finalUsername = formatUsername(firstName, lastName, suffix);

    return finalUsername;
  } catch (err) {
    logger.error(`Error while generating unique username: ${err.message}`);
    throw err;
  }
};

/**
 * Helper functions to modularize logic for GET /users
 */

async function handleUserById(res, userId) {
  try {
    const result = await dataAccess.retrieveUsers({ id: userId });
    if (!result.userExists) return res.boom.notFound("User doesn't exist");
    return res.json({ message: "User returned successfully!", user: result.user });
  } catch (error) {
    logger.error(`Error while fetching user: ${error}`);
    return res.boom.serverUnavailable(SOMETHING_WENT_WRONG);
  }
}

async function handleUserByProfileData(res, userId) {
  try {
    const result = await dataAccess.retrieveUsers({ id: userId });
    return res.send(result.user);
  } catch (error) {
    logger.error(`Error while fetching user: ${error}`);
    return res.boom.serverUnavailable(INTERNAL_SERVER_ERROR);
  }
}

async function handleUnmergedPRs(res, days) {
  try {
    const inDiscordUsers = await dataAccess.retrieveUsersWithRole(INDISCORD);
    const inactiveUsers = [];

    for (const user of inDiscordUsers) {
      if (!(await isLastPRMergedWithinDays(user.github_id, days))) {
        inactiveUsers.push(user.id);
      }
    }

    return res.json({
      message: "Inactive users returned successfully!",
      count: inactiveUsers.length,
      users: inactiveUsers,
    });
  } catch (error) {
    logger.error(`Error fetching inactive users: ${error}`);
    return res.boom.serverUnavailable("Something went wrong, please contact admin");
  }
}

async function handleUserByDiscordId(res, discordId) {
  try {
    const result = await dataAccess.retrieveUsers({ discordId });
    if (!result.userExists) return res.json({ message: "User not found", user: null });

    const userStatus = await getUserStatus(result.user.id);
    if (userStatus.userStatusExists) {
      result.user.state = userStatus.data.currentStatus.state;
    }

    return res.json({ message: "User returned successfully!", user: result.user });
  } catch (error) {
    logger.error(`Error fetching user by Discord ID: ${error}`);
    return res.boom.serverUnavailable(INTERNAL_SERVER_ERROR);
  }
}

async function handleDepartedUsers(res, query) {
  try {
    const result = await dataAccess.retrieveUsers({ query });
    const departedUsers = await getUsersWithIncompleteTasks(result.users);

    if (departedUsers.length === 0) return res.status(204).send();

    return res.json({
      message: "Users with abandoned tasks fetched successfully",
      users: departedUsers,
      links: generatePaginationLinks(query, result),
    });
  } catch (error) {
    logger.error("Error fetching users who abandoned tasks:", error);
    return res.boom.badImplementation(INTERNAL_SERVER_ERROR);
  }
}

async function handleOverdueTasks(res, days) {
  try {
    const tasksData = await getOverdueTasks(days);
    if (!tasksData.length) return res.json({ message: "No users found", users: [] });

    const userIds = [...new Set(tasksData.map((task) => task.assignee).filter(Boolean))];
    const users = await dataAccess.retrieveUsers({ userIds });

    const usersData = users
      .filter((user) => !user.roles.archived)
      .map((user) => ({
        id: user.id,
        discordId: user.discordId,
        username: user.username,
        tasks: tasksData.filter((task) => task.assignee === user.id),
      }));

    return res.json({ message: "Users returned successfully!", count: usersData.length, users: usersData });
  } catch (error) {
    logger.error(`Error fetching overdue tasks: ${error}`);
    return res.boom.serverUnavailable(SOMETHING_WENT_WRONG);
  }
}

async function handleFilteredPRs(res, qualifiers) {
  try {
    const allPRs = await getFilteredPRsOrIssues(qualifiers);
    const usernames = getUsernamesFromPRs(allPRs);
    const users = await dataAccess.retrieveUsers({ usernames });

    return res.json({ message: "Users returned successfully!", users });
  } catch (error) {
    logger.error(`Error fetching PR-filtered users: ${error}`);
    return res.boom.serverUnavailable(SOMETHING_WENT_WRONG);
  }
}

async function handleAllUsers(res, query) {
  try {
    const data = await dataAccess.retrieveUsers({ query });
    return res.json({
      message: "Users returned successfully!",
      users: data.users,
      links: generatePaginationLinks(query, data),
    });
  } catch (error) {
    logger.error(`Error fetching all users: ${error}`);
    return res.boom.serverUnavailable(SOMETHING_WENT_WRONG);
  }
}

module.exports = {
  generateUniqueUsername,
  getUsersWithIncompleteTasks,
  handleAllUsers,
  handleFilteredPRs,
  handleUserById,
  handleUserByProfileData,
  handleOverdueTasks,
  handleDepartedUsers,
  handleUserByDiscordId,
  handleUnmergedPRs,
};
